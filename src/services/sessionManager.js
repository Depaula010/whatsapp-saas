// ========================================
// Session Manager - Orquestrador Multi-Sessão (CORRIGIDO)
// ========================================

const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const qrcode = require('qrcode-terminal'); // <--- IMPORTANTE: Garanta que instalou (npm install qrcode-terminal)
const { createAuthState, removeAuthState } = require('../models/authState');
const Session = require('../models/session');
const { pool } = require('../config/database');
const { generateWebhookSignature } = require('../utils/crypto');
const { formatarChatId, extrairNumero, isBroadcast } = require('../utils/formatting');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

class SessionManager {
    constructor() {
        this.activeSessions = new Map();
        this.qrCodeCache = new Map();
        this.reconnectAttempts = new Map();
        this.qrScanTimeouts = new Map();
        this.circuitBreakers = new Map();
        this.sessionMetrics = new Map();      // W26
        this.recipientRateLimit = new Map();  // W28
        this.sessionMessageStores = new Map(); // Retransmissão correta de mensagens (getMessage)
        this.maxConcurrentSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '50', 10);

        this._startOrphanCleanupJob(); // W27
    }

    // =========================================================
    // W27 — CLEANUP DE SESSÕES ÓRFÃS
    // =========================================================

    _startOrphanCleanupJob() {
        const intervalMs = parseInt(process.env.ORPHAN_CLEANUP_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
        // Primeira execução com pequeno delay para o processo inicializar
        setTimeout(() => {
            this._cleanupOrphanSessions();
            setInterval(() => this._cleanupOrphanSessions(), intervalMs);
        }, 30_000);
        logger.info({ intervalMs }, '[ORPHAN-CLEANUP] Job de cleanup de sessões órfãs agendado');
    }

    async _cleanupOrphanSessions() {
        const timeoutMs = parseInt(process.env.ORPHAN_TIMEOUT_MS || String(10 * 60 * 1000), 10);
        const cutoff = new Date(Date.now() - timeoutMs);

        logger.info({ cutoff: cutoff.toISOString() }, '[ORPHAN-CLEANUP] Iniciando verificação de sessões órfãs');

        try {
            const connectingSessions = await Session.findAll({ status: 'connecting' });
            const orphans = connectingSessions.filter(s => new Date(s.updated_at) < cutoff);

            if (orphans.length === 0) {
                logger.debug('[ORPHAN-CLEANUP] Nenhuma sessão órfã encontrada');
                return;
            }

            logger.warn({ count: orphans.length }, '[ORPHAN-CLEANUP] Sessões órfãs encontradas — forçando disconnected');

            for (const session of orphans) {
                try {
                    // Fecha socket em memória se houver, sem atualizar DB (faremos abaixo)
                    const sock = this.activeSessions.get(session.id);
                    if (sock) {
                        try { sock.end(undefined); } catch (_) {}
                        this.activeSessions.delete(session.id);
                    }
                    this.qrCodeCache.delete(session.id);
                    this._clearQrScanTimeout(session.id);

                    await Session.updateStatus(session.id, 'disconnected');
                    await this.logEvent(session.id, 'orphan_cleanup', {
                        previous_status: 'connecting',
                        stuck_since: session.updated_at,
                        timeout_ms: timeoutMs,
                    });

                    logger.warn({ sessionId: session.id, sessionName: session.session_name },
                        '[ORPHAN-CLEANUP] Sessão órfã marcada como disconnected');
                } catch (sessionErr) {
                    logger.error({ err: sessionErr, sessionId: session.id }, '[ORPHAN-CLEANUP] Erro ao limpar sessão órfã');
                }
            }
        } catch (err) {
            logger.error({ err }, '[ORPHAN-CLEANUP] Erro ao buscar sessões connecting no banco');
        }
    }

    // =========================================================
    // W28 — RATE LIMITING POR DESTINATÁRIO
    // =========================================================

    _checkRateLimit(sessionId, remoteJid) {
        const limit = parseInt(process.env.RATE_LIMIT_PER_RECIPIENT || '5', 10);
        const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
        const key = `${sessionId}:${remoteJid}`;
        const now = Date.now();

        if (!this.recipientRateLimit.has(key)) {
            this.recipientRateLimit.set(key, []);
        }

        const timestamps = this.recipientRateLimit.get(key);

        // Remove timestamps fora da janela
        const recent = timestamps.filter(t => now - t < windowMs);
        this.recipientRateLimit.set(key, recent);

        if (recent.length >= limit) {
            logger.warn({ sessionId, remoteJid, count: recent.length, limit, windowMs },
                '[RATE-LIMIT] Limite de mensagens por destinatário atingido — mensagem bloqueada');
            return false;
        }

        recent.push(now);
        return true;
    }

    // W26 — inicializa (ou reseta) o bloco de métricas de uma sessão
    _initMetrics(sessionId) {
        this.sessionMetrics.set(sessionId, {
            messages_received: 0,
            messages_sent: 0,
            webhook_errors: 0,
            circuit_breaker_trips: 0,
            connected_at: null,
            reconnect_count: 0,
        });
    }

    // W26 — retorna métricas em memória; nunca lança exceção
    getSessionMetrics(sessionId) {
        return this.sessionMetrics.get(sessionId) ?? null;
    }

    async createSession(sessionId) {
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
            throw new Error(`Maximum concurrent sessions limit reached: ${this.maxConcurrentSessions}`);
        }

        // Se a sessão já existe na memória, retorna ela (evita duplicação)
        if (this.activeSessions.has(sessionId)) {
            logger.warn({ sessionId }, 'Sessão já está ativa');
            return this.activeSessions.get(sessionId);
        }

        const sessionConfig = await Session.findById(sessionId);
        if (!sessionConfig) {
            throw new Error('Session not found in database');
        }

        logger.info({ sessionId, sessionName: sessionConfig.session_name }, 'Criando nova sessão WhatsApp');

        try {
            const { state, saveCreds, loadCreds, clearCreds } = await createAuthState(sessionId);

            // Tentar carregar credenciais existentes
            try {
                await loadCreds();
                console.log(`[${sessionConfig.session_name}] Credenciais carregadas do banco`);
            } catch (loadError) {
                // Se falhar ao carregar (credenciais corrompidas do formato antigo), limpar tudo
                console.error(`[${sessionConfig.session_name}] ⚠️  Erro ao carregar credenciais antigas:`, loadError.message);
                console.log(`[${sessionConfig.session_name}] 🔄 Limpando credenciais corrompidas...`);
                await clearCreds();
                console.log(`[${sessionConfig.session_name}] ✨ Começando com credenciais novas`);
            }

            const { version } = await fetchLatestBaileysVersion();
            logger.info({ sessionId, version: version.join('.') }, 'Versão do Baileys obtida');

            // Cache de retentativa de mensagens (Vital para evitar erro 515 na decifragem)
            const msgRetryCounterCache = new Map();

            // Store das últimas mensagens enviadas (para retransmissão pelo WhatsApp via getMessage)
            const messageStore = new Map();
            this.sessionMessageStores.set(sessionId, messageStore);

            const sock = makeWASocket({
                version,
                logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
                printQRInTerminal: false, // Desligado nativo para usarmos o qrcode-terminal
                auth: {
                    creds: state.creds,
                    keys: state.keys
                },
                // Navegador mais "aceitável" para evitar desconexões
                browser: ['Ubuntu', 'Chrome', '20.0.04'],

                // === CONFIGURAÇÕES DE ESTABILIDADE ===
                msgRetryCounterCache, // Adicionado para estabilidade
                syncFullHistory: false, // Não sincroniza histórico completo (evita 515)
                markOnlineOnConnect: false, // Não marca online imediatamente
                connectTimeoutMs: 60000, // Timeout de 60s para conexão
                defaultQueryTimeoutMs: 60000, // Aumentado para 60s (evita timeout em queries lentas)
                keepAliveIntervalMs: 10000, // Keep-alive mais agressivo (10s) para manter stream ativa
                retryRequestDelayMs: 250, // Delay menor entre retries

                getMessage: async (key) => {
                    // Retorna a mensagem do store local; undefined = não encontrada (skip retransmissão)
                    return messageStore.get(key.id);
                }
            });

            // === LISTENERS DE EVENTOS ===

            // Handler de conexão
            sock.ev.on('connection.update', async (update) => {
                await this.handleConnectionUpdate(sessionId, update, sessionConfig);
            });

            // Handler de credenciais - CRÍTICO para manter sessão
            sock.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                    logger.debug({ sessionId }, 'Credenciais atualizadas e salvas');
                } catch (error) {
                    logger.error({ err: error, sessionId }, 'ERRO ao salvar credenciais');
                }
            });

            // Handler de mensagens
            sock.ev.on('messages.upsert', async (m) => {
                await this.handleIncomingMessage(sessionId, m, sessionConfig);
            });

            // Handler de erros do WebSocket (novo)
            sock.ws.on('error', (error) => {
                logger.error({ err: error, sessionId }, 'Erro no WebSocket');
            });

            // Adiciona na memória
            this.activeSessions.set(sessionId, sock);
            await Session.updateStatus(sessionId, 'connecting');

            logger.info({ sessionId }, 'Sessão WhatsApp criada com sucesso');

            return sock;
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro ao criar sessão');
            await Session.updateStatus(sessionId, 'failed');
            // Garante limpeza em caso de erro na criação
            this.activeSessions.delete(sessionId);
            throw error;
        }
    }

    async handleConnectionUpdate(sessionId, update, config) {
        const { connection, lastDisconnect, qr } = update;

        console.log(`[${config.session_name}] Connection update:`, { connection, hasQr: !!qr, statusCode: lastDisconnect?.error?.output?.statusCode });

        try {
            // === 1. LÓGICA DE QR CODE ===
            if (qr) {
                console.log(`[${config.session_name}] ✨ QR Code gerado!`);
                logger.info({ sessionId }, 'QR Code gerado');
                const expiresAt = new Date(Date.now() + 60000);

                this.qrCodeCache.set(sessionId, { qr, expiresAt });
                await Session.updateQR(sessionId, qr, expiresAt);

                // IMPRIMIR NO TERMINAL (FUNDAMENTAL)
                console.log('\n========================================');
                console.log('🔐 ESCANEIE O QR CODE ABAIXO:');
                console.log('Sessão: ' + config.session_name);
                qrcode.generate(qr, { small: true });
                console.log('========================================\n');

                await this.logEvent(sessionId, 'qr_generated', { expires_at: expiresAt.toISOString() });

                // W15: inicia timer de scan apenas no primeiro QR — não reseta em QRs subsequentes
                if (!this.qrScanTimeouts.has(sessionId)) {
                    const timeoutMs = parseInt(process.env.QR_SCAN_TIMEOUT_MS || '300000', 10);
                    const handle = setTimeout(() => this._handleQrScanTimeout(sessionId, config), timeoutMs);
                    this.qrScanTimeouts.set(sessionId, handle);
                    logger.info({ sessionId, timeoutMs }, 'QR scan timeout iniciado');
                }
            }

            // === 2. CONEXÃO BEM SUCEDIDA ===
            if (connection === 'open') {
                const sock = this.activeSessions.get(sessionId);
                if (sock && sock.user) {
                    const phoneNumber = sock.user.id.split(':')[0];
                    console.log(`[${config.session_name}] ✅ Sessão conectada! Telefone: ${phoneNumber}`);
                    logger.info({ sessionId, phoneNumber }, 'Sessão conectada com sucesso');

                    await Session.update(sessionId, {
                        status: 'connected',
                        phone_number: phoneNumber,
                        last_connected_at: new Date(),
                        qr_code: null,
                        qr_expires_at: null
                    });

                    this.qrCodeCache.delete(sessionId);
                    this.reconnectAttempts.delete(sessionId);
                    this._clearQrScanTimeout(sessionId);

                    // W26: marca horário de conexão
                    if (!this.sessionMetrics.has(sessionId)) this._initMetrics(sessionId);
                    this.sessionMetrics.get(sessionId).connected_at = new Date();

                    console.log('\n✅ *** BOT CONECTADO COM SUCESSO! ***\n');
                }
            }

            // === 3. CONEXÃO FECHADA E RECONEXÃO ===
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                // W18: ban (403) também não deve tentar reconectar — mantém auth para quando ban expirar
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut
                    && statusCode !== DisconnectReason.forbidden;

                // === TRATAMENTO ESPECIAL PARA ERRO 515 ===
                // Erro 515 indica auth corrompido - geralmente precisa limpar.
                // Mas as vezes é apenas instabilidade. Vamos tentar reconectar 3x antes de desistir.
                if (statusCode === 515) {
                    const currentAttempts = this.reconnectAttempts.get(sessionId) || 0;

                    // Só limpa se já tentou 3 vezes (0, 1, 2)
                    if (currentAttempts >= 3) {
                        logger.warn({ sessionId, attempts: currentAttempts }, 'Erro 515 persistente. Limpando credenciais...');

                        try {
                            await removeAuthState(sessionId);
                            await Session.updateStatus(sessionId, 'disconnected');
                            this.activeSessions.delete(sessionId);
                            this.qrCodeCache.delete(sessionId);
                            this.reconnectAttempts.delete(sessionId);
                            this._clearQrScanTimeout(sessionId);

                            console.log('\n========================================');
                            console.log('⚠️  ERRO 515: Auth corrompido detectado (após ' + currentAttempts + ' tentativas)!');
                            console.log('🔄 Credenciais limpas. Reiniciando sessão...');
                            console.log('📱 Um novo QR Code será gerado.');
                            console.log('========================================\n');

                            // Delay mais longo para garantir limpeza completa
                            setTimeout(() => {
                                this.createSession(sessionId).catch(err => {
                                    logger.error({ err, sessionId }, 'Erro ao recriar sessão após 515');
                                });
                            }, 3000);
                        } catch (cleanupError) {
                            logger.error({ err: cleanupError, sessionId }, 'Erro ao limpar auth após 515');
                            await Session.updateStatus(sessionId, 'failed');
                        }
                        return;
                    } else {
                        console.log(`[${config.session_name}] ⚠️ Erro 515 detectado (Tentativa ${currentAttempts + 1}/3). Tentando reconexão simples...`);
                        logger.warn({ sessionId, attempt: currentAttempts + 1 }, 'Erro 515 - Tentando reconexão antes de limpar credenciais');
                        // Deixa cair no fluxo normal de reconexão abaixo (que incrementa o contador)
                    }
                }
                // ============================================

                // Se caiu mas pode voltar (Ex: Timeout de QR Code ou Queda de Net)
                if (shouldReconnect) {
                    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
                    this.reconnectAttempts.set(sessionId, attempts);
                    const delay = Math.min(attempts * 5000, 30000); // Max 30s

                    if (attempts <= 10) { // Aumentei um pouco as tentativas
                        logger.info({ sessionId, attempts }, `Conexão caiu (${statusCode}). Tentando reconectar em ${delay}ms...`);

                        // === CORREÇÃO CRÍTICA AQUI ===
                        // Removemos a sessão antiga da memória para permitir que o createSession crie uma nova
                        this.activeSessions.delete(sessionId);
                        // ==============================

                        setTimeout(() => {
                            this.createSession(sessionId).catch(err => logger.error({ err }, 'Erro fatal na reconexão'));
                        }, delay);
                    } else {
                        logger.error({ sessionId, attempts }, 'Muitas tentativas falhas. Desistindo.');
                        const reason = `reconnect_exhausted_statusCode_${statusCode ?? 'unknown'}`;
                        await this.sendFailureWebhook(sessionId, config, reason);
                        await this.logEvent(sessionId, 'session_failed', { reason, attempts, statusCode });
                        await Session.updateStatus(sessionId, 'failed');
                        this.activeSessions.delete(sessionId);
                        this.reconnectAttempts.delete(sessionId);
                        this._clearQrScanTimeout(sessionId);
                    }
                } else {
                    // W18: diferenciar logout manual (401) de ban temporário (403)
                    const isBanned = statusCode === DisconnectReason.forbidden;
                    const reason = isBanned ? 'banned' : 'logged_out';
                    logger.info({ sessionId, statusCode, reason }, 'Sessão encerrada definitivamente');
                    await Session.updateStatus(sessionId, 'disconnected');
                    if (!isBanned) {
                        // Logout manual: credenciais inválidas — limpar auth
                        await removeAuthState(sessionId);
                    }
                    // Ban temporário: mantém auth para quando o ban expirar
                    await this.sendFailureWebhook(sessionId, config, reason);
                    await this.logEvent(sessionId, 'session_failed', { reason, statusCode });
                    this.activeSessions.delete(sessionId);
                    this.qrCodeCache.delete(sessionId);
                    this._clearQrScanTimeout(sessionId);
                }
            }
        } catch (error) {
            logger.error({ err: error, sessionId }, 'Erro no handler de conexão');
        }
    }

    async handleIncomingMessage(sessionId, m, config) {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || isBroadcast(msg.key.remoteJid)) return;

        try {
            // Extrair texto da mensagem (suporte a diversos formatos)
            const conversation = msg.message.conversation;
            const extendedText = msg.message.extendedTextMessage?.text;

            // === SUPORTE A MÍDIA (Google Drive Upload) ===
            const imageMessage = msg.message.imageMessage;
            const documentMessage = msg.message.documentMessage;
            const audioMessage = msg.message.audioMessage;

            // Caption pode vir de imagem ou documento
            const mediaCaption = imageMessage?.caption || documentMessage?.caption;

            // W29: seleção de linha de lista interativa — rowId é a data/hora escolhida
            const listResponseId = msg.message.listResponseMessage?.selectedRowId;

            // Detectar mídia ANTES da verificação de texto
            const hasMedia = imageMessage || documentMessage || audioMessage;

            // Se tem mídia mas sem legenda, usar comando padrão para o Drive
            const textoBase = conversation || extendedText || mediaCaption || listResponseId;
            const texto = textoBase || (hasMedia ? 'salvar no drive' : null);

            if (!texto) return; // Ignora mensagens sem texto e sem mídia (ex: sticker)

            const remoteJid = msg.key.remoteJid;
            // Apenas mensagens privadas por enquanto
            if (remoteJid.includes('@g.us')) return;

            // W28: rate limit por destinatário — verificar antes de qualquer envio
            if (!this._checkRateLimit(sessionId, remoteJid)) {
                await this.logEvent(sessionId, 'rate_limit_exceeded', { remoteJid, texto });
                return;
            }

            // W16: circuit breaker — bloqueia chamadas ao backend quando aberto
            if (this.isCircuitOpen(sessionId)) {
                logger.warn({ sessionId, from: remoteJid }, 'Circuit breaker aberto — enviando mensagem padrão ao usuário');
                const sockCb = this.activeSessions.get(sessionId);
                if (sockCb) {
                    const userMsg = process.env.CIRCUIT_BREAKER_USER_MSG || 'Estamos com instabilidade, tente em instantes';
                    await sockCb.sendMessage(remoteJid, { text: userMsg });
                }
                return;
            }

            logger.info({ sessionId, from: remoteJid }, `Mensagem recebida: ${texto}`);

            // W26: contabiliza mensagem recebida
            if (!this.sessionMetrics.has(sessionId)) this._initMetrics(sessionId);
            this.sessionMetrics.get(sessionId).messages_received++;

            // === PROCESSAR MÍDIA PARA UPLOAD ===
            let mediaPayload = {};

            if (hasMedia) {
                try {
                    logger.info({ sessionId, mimeType: hasMedia.mimetype }, 'Baixando mídia...');
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});

                    mediaPayload = {
                        media_data: buffer.toString('base64'),
                        media_type: hasMedia.mimetype,
                        media_filename: hasMedia.fileName || `arquivo_${Date.now()}`
                    };

                    logger.info({ sessionId, type: hasMedia.mimetype, size: buffer.length }, 'Mídia capturada com sucesso');
                } catch (mediaErr) {
                    console.error(`[${config.session_name}] ❌ Falha ao baixar mídia: ${mediaErr.message}`);
                    const sock = this.activeSessions.get(sessionId);
                    if (sock) {
                        await sock.sendMessage(remoteJid, { text: '❌ Não consegui processar o arquivo enviado. Tente novamente.' });
                    }
                    return;
                }
            }

            // WhatsApp Multi-Device usa LID (@lid) em vez do número de telefone.
            // Para lookup no backend, precisamos do número real (senderPn).
            const isLidJid = remoteJid.endsWith('@lid');
            const senderForLookup = isLidJid
                ? (msg.key.senderPn || remoteJid)
                : remoteJid;

            // Preparar payload (com ou sem mídia)
            const payload = {
                texto: texto,
                numero_remetente: senderForLookup,
                ...mediaPayload
            };

            // Gerar assinatura HMAC (Segurança)
            // === SAAS / MULTI-TENANCY SUPPORT ===
            // A URL do webhook deve vir ESTRITAMENTE da configuração da sessão no banco.
            // Sem fallback para variáveis de ambiente globais.
            const webhookUrl = config.webhook_url;

            if (!webhookUrl) {
                logger.warn({ sessionId }, 'Webhook URL não configurada na sessão. Ignorando mensagem.');
                return;
            }

            // === AUTENTICAÇÃO DINÂMICA ===
            // 1. Tenta pegar o token nos metadados da sessão
            // 2. Fallback para a chave global do .env
            const apiKey = config.metadata?.webhook_auth_token || process.env.API_SECRET_KEY;

            // Chave HMAC específica da sessão (ou global)
            const signatureKey = config.webhook_signature_key || process.env.WEBHOOK_SIGNATURE_KEY;

            logger.debug({
                sessionId,
                url: webhookUrl,
                usingSessionConfig: !!config.webhook_url
            }, 'Enviando webhook...');

            // Preparar headers dinâmicos
            let headers = {
                'Content-Type': 'application/json'
            };

            if (apiKey) {
                headers['x-api-key'] = apiKey;
            }

            // IMPORTANTE: Serializar o payload ANTES de assinar.
            // O backend valida o HMAC dos bytes recebidos, então precisamos garantir
            // que assinamos EXATAMENTE a mesma string que enviamos.
            const payloadString = JSON.stringify(payload);

            // Assina freshly para esta tentativa.
            // _scheduleWebhookRetry também recalcula a assinatura em cada retry —
            // nunca reutiliza o valor cacheado do attempt original (W31).
            if (signatureKey) {
                headers['X-Webhook-Signature'] = generateWebhookSignature(payloadString, signatureKey);
            }

            // W17: inner try-catch no POST para isolar erros do backend dos demais erros do handler
            try {
                // Enviar a STRING serializada (não o objeto) para garantir consistência
                const response = await axios.post(webhookUrl, payloadString, { headers, timeout: 15000 });
                this._resetBackendCircuit(sessionId);

                // Processar resposta do Backend
                const sock = this.activeSessions.get(sessionId);
                if (response.data && response.data.interactiveList && sock) {
                    const il = response.data.interactiveList;
                    const sections = (il.sections || []).map(s => ({
                        title: s.title || '',
                        rows:  (s.rows || []).map(r => ({ rowId: r.rowId || '', title: r.title || '', description: r.description || '' }))
                    }));
                    await sock.sendMessage(remoteJid, {
                        listMessage: {
                            title:       il.title      || '',
                            description: il.body       || '',
                            buttonText:  il.buttonText || 'Opções',
                            listType:    1,
                            sections
                        }
                    });
                    if (this.sessionMetrics.has(sessionId)) this.sessionMetrics.get(sessionId).messages_sent++;
                } else if (response.data && response.data.resposta && sock) {
                    const respostaTexto = response.data.resposta;
                    logger.info({ sessionId, to: remoteJid }, `Enviando resposta: ${respostaTexto}`);
                    await sock.sendMessage(remoteJid, { text: respostaTexto });
                    // W26: contabiliza mensagem enviada
                    if (this.sessionMetrics.has(sessionId)) {
                        this.sessionMetrics.get(sessionId).messages_sent++;
                    }
                }
            } catch (postErr) {
                const httpStatus = postErr.response?.status;
                const isRetryable = !httpStatus || httpStatus >= 500;

                if (httpStatus && httpStatus >= 500) {
                    logger.warn({ sessionId, httpStatus }, 'Erro 5xx do backend — registrando falha no circuit breaker');
                    await this._recordBackendFailure(sessionId, config);
                }

                if (isRetryable) {
                    // Passa signatureKey separado para que cada retry recalcule a assinatura.
                    // Passa headers SEM 'X-Webhook-Signature' — o retry constrói o header fresh (W31).
                    const { 'X-Webhook-Signature': _drop, ...baseHeaders } = headers;
                    this._scheduleWebhookRetry(sessionId, config, webhookUrl, payloadString, baseHeaders, signatureKey, 1, { remoteJid, texto });
                    logger.warn({ err: postErr.message, sessionId }, 'Webhook falhou — retry agendado');
                } else {
                    logger.error({ err: postErr.message, sessionId, httpStatus }, 'Erro não retentável — mensagem descartada');
                    await this.logEvent(sessionId, 'message_failed', { remoteJid, texto, httpStatus, attempts: 1 });
                    // W26: contabiliza erro de webhook
                    if (this.sessionMetrics.has(sessionId)) {
                        this.sessionMetrics.get(sessionId).webhook_errors++;
                    }
                }
            }

        } catch (e) {
            logger.error({ err: e.message, sessionId }, 'Erro inesperado ao processar mensagem recebida');
        }
    }

    async sendMessage(sessionId, numero, mensagem) {
        const sock = this.activeSessions.get(sessionId);
        if (!sock) throw new Error('Session not connected');
        const chatId = formatarChatId(numero);
        const result = await sock.sendMessage(chatId, { text: mensagem });
        if (result?.key?.id) {
            const store = this.sessionMessageStores.get(sessionId);
            if (store) {
                store.set(result.key.id, { conversation: mensagem });
                // Mantém no máximo 200 entradas para evitar vazamento de memória
                if (store.size > 200) store.delete(store.keys().next().value);
            }
        }
        return result;
    }

    async sendImage(sessionId, numero, imageBuffer, caption = '') {
        const sock = this.activeSessions.get(sessionId);
        if (!sock) throw new Error('Session not connected');
        const chatId = formatarChatId(numero);
        return await sock.sendMessage(chatId, { image: imageBuffer, caption });
    }

    // W29 — lista de opções como texto numerado (Baileys 6.x não suporta listMessage nativamente)
    async sendInteractive(sessionId, numero, interactiveList) {
        const sock = this.activeSessions.get(sessionId);
        if (!sock) throw new Error('Session not connected');
        const chatId = formatarChatId(numero);

        const lines = [];
        if (interactiveList.title) lines.push(`*${interactiveList.title}*`);
        if (interactiveList.body)  lines.push(interactiveList.body);
        lines.push('');

        let i = 1;
        for (const section of (interactiveList.sections || [])) {
            for (const row of (section.rows || [])) {
                const desc = row.description ? ` _(${row.description})_` : '';
                lines.push(`${i}. ${row.title}${desc}`);
                i++;
            }
        }

        lines.push('');
        lines.push('_Responda com o número ou nome da opção._');

        return await sock.sendMessage(chatId, { text: lines.join('\n') });
    }

    getSession(sessionId) { return this.activeSessions.get(sessionId); }
    getQRCode(sessionId) { return this.qrCodeCache.get(sessionId); }
    getStats() { return { active_sessions: this.activeSessions.size }; }

    async disconnectSession(sessionId, shouldUpdateDb = true) {
        const sock = this.activeSessions.get(sessionId);
        if (sock) {
            sock.end(undefined);
            this.activeSessions.delete(sessionId);
        }
        this.sessionMessageStores.delete(sessionId);

        if (shouldUpdateDb) {
            await Session.updateStatus(sessionId, 'disconnected');
        }
    }

    /**
     * Desvincula o número atual da sessão (logout real), permitindo que um
     * novo QR Code seja escaneado com outro número — sem precisar de acesso
     * físico ao aparelho antigo para remover o dispositivo pelo WhatsApp.
     * Diferente de disconnectSession(), que só fecha o socket e mantém as
     * credenciais salvas (reconecta no mesmo número).
     */
    async logoutSession(sessionId) {
        const sock = this.activeSessions.get(sessionId);

        if (sock) {
            try {
                // Notifica o WhatsApp que o dispositivo está saindo. Isso
                // também dispara connection.update com DisconnectReason.loggedOut,
                // mas fazemos a limpeza aqui embaixo de qualquer forma para não
                // depender da ordem/timing desse evento.
                await sock.logout();
            } catch (error) {
                logger.warn({ err: error, sessionId }, 'Erro ao notificar logout via socket, limpando credenciais mesmo assim');
            }
            this.activeSessions.delete(sessionId);
        }

        this.sessionMessageStores.delete(sessionId);
        this.qrCodeCache.delete(sessionId);
        this.reconnectAttempts.delete(sessionId);
        this._clearQrScanTimeout(sessionId);

        await removeAuthState(sessionId);
        await Session.update(sessionId, {
            status: 'disconnected',
            phone_number: null,
            qr_code: null,
            qr_expires_at: null
        });

        await this.logEvent(sessionId, 'session_logout', { manual: true });
    }

    // =========================================================
    // W17 — RETRY COM BACKOFF PARA WEBHOOK DE MENSAGEM
    // =========================================================

    // W17 + W31: Retry com backoff exponencial.
    // signatureKey é passado separado para que cada tentativa recalcule o X-Webhook-Signature
    // a partir do payloadString — nunca reutiliza o header cacheado do attempt original.
    _scheduleWebhookRetry(sessionId, config, url, payloadString, baseHeaders, signatureKey, attempt, msgContext) {
        const delays = [5000, 30000, 120000]; // 5s, 30s, 2min
        const maxAttempts = parseInt(process.env.WEBHOOK_RETRY_MAX || '3', 10);

        if (attempt > maxAttempts) {
            logger.error({ sessionId, attempts: attempt }, 'Webhook falhou após todas as tentativas — registrando message_failed');
            this.logEvent(sessionId, 'message_failed', {
                remoteJid: msgContext.remoteJid,
                texto: msgContext.texto,
                attempts: attempt
            }).catch(() => {});
            // W26: contabiliza erro de webhook após exaustão
            if (this.sessionMetrics.has(sessionId)) {
                this.sessionMetrics.get(sessionId).webhook_errors++;
            }
            return;
        }

        const delay = delays[attempt - 1] ?? delays[delays.length - 1];
        logger.info({ sessionId, attempt, maxAttempts, delayMs: delay }, 'Retry de webhook agendado');

        setTimeout(async () => {
            // W31: recalcula assinatura fresh a cada attempt — nunca cacheada do original.
            const headers = { ...baseHeaders };
            if (signatureKey) {
                headers['X-Webhook-Signature'] = generateWebhookSignature(payloadString, signatureKey);
            }

            try {
                const response = await axios.post(url, payloadString, { headers, timeout: 15000 });
                this._resetBackendCircuit(sessionId);
                logger.info({ sessionId, attempt }, 'Retry de webhook bem-sucedido');

                if (response.data?.resposta) {
                    const sock = this.activeSessions.get(sessionId);
                    if (sock && msgContext.remoteJid) {
                        await sock.sendMessage(msgContext.remoteJid, { text: response.data.resposta });
                        // W26: contabiliza mensagem enviada via retry
                        if (this.sessionMetrics.has(sessionId)) {
                            this.sessionMetrics.get(sessionId).messages_sent++;
                        }
                    }
                }
            } catch (retryErr) {
                const httpStatus = retryErr.response?.status;
                const isRetryable = !httpStatus || httpStatus >= 500;

                if (httpStatus && httpStatus >= 500) {
                    this._recordBackendFailure(sessionId, config).catch(() => {});
                }

                logger.warn({ sessionId, attempt, err: retryErr.message, httpStatus }, 'Retry de webhook falhou');

                if (isRetryable) {
                    this._scheduleWebhookRetry(sessionId, config, url, payloadString, baseHeaders, signatureKey, attempt + 1, msgContext);
                } else {
                    logger.error({ sessionId, httpStatus }, 'Retry abortado — erro não retentável (4xx)');
                    this.logEvent(sessionId, 'message_failed', {
                        remoteJid: msgContext.remoteJid,
                        texto: msgContext.texto,
                        attempts: attempt,
                        httpStatus
                    }).catch(() => {});
                }
            }
        }, delay);
    }

    // =========================================================
    // W15 — QR SCAN TIMEOUT
    // =========================================================

    _clearQrScanTimeout(sessionId) {
        const handle = this.qrScanTimeouts.get(sessionId);
        if (handle) {
            clearTimeout(handle);
            this.qrScanTimeouts.delete(sessionId);
        }
    }

    async _handleQrScanTimeout(sessionId, config) {
        this.qrScanTimeouts.delete(sessionId);
        const sock = this.activeSessions.get(sessionId);
        if (!sock) return; // sessão já foi limpa por outro fluxo

        logger.warn({ sessionId }, 'QR scan timeout: nenhum scan dentro do prazo');
        try { sock.end(undefined); } catch (_) {}

        this.activeSessions.delete(sessionId);
        this.qrCodeCache.delete(sessionId);

        await Session.update(sessionId, { status: 'disconnected', qr_code: null, qr_expires_at: null });
        await this.sendFailureWebhook(sessionId, config, 'qr_scan_timeout');
        await this.logEvent(sessionId, 'session_failed', { reason: 'qr_scan_timeout' });
    }

    // =========================================================
    // W16 — CIRCUIT BREAKER PARA O BACKEND
    // =========================================================

    _getCircuit(sessionId) {
        if (!this.circuitBreakers.has(sessionId)) {
            this.circuitBreakers.set(sessionId, { failures: 0, firstFailureAt: null, isOpen: false, openedAt: null });
        }
        return this.circuitBreakers.get(sessionId);
    }

    isCircuitOpen(sessionId) {
        const cb = this.circuitBreakers.get(sessionId);
        if (!cb || !cb.isOpen) return false;
        const resetMs = parseInt(process.env.CIRCUIT_BREAKER_RESET_MS || '300000', 10);
        if (Date.now() - cb.openedAt >= resetMs) {
            cb.isOpen = false;
            cb.failures = 0;
            cb.firstFailureAt = null;
            cb.openedAt = null;
            logger.info({ sessionId }, 'Circuit breaker auto-resetado após período de espera');
            return false;
        }
        return true;
    }

    async _recordBackendFailure(sessionId, config) {
        const threshold = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '3', 10);
        const windowMs = parseInt(process.env.CIRCUIT_BREAKER_WINDOW_MS || '60000', 10);
        const cb = this._getCircuit(sessionId);
        const now = Date.now();

        if (!cb.firstFailureAt || now - cb.firstFailureAt > windowMs) {
            cb.failures = 1;
            cb.firstFailureAt = now;
        } else {
            cb.failures++;
        }

        logger.warn({ sessionId, failures: cb.failures, threshold }, 'Falha de backend registrada');

        if (cb.failures >= threshold && !cb.isOpen) {
            cb.isOpen = true;
            cb.openedAt = now;
            logger.error({ sessionId, failures: cb.failures }, 'Circuit breaker aberto');
            await this.sendFailureWebhook(sessionId, config, 'backend_circuit_open');
            await this.logEvent(sessionId, 'circuit_breaker_open', { failures: cb.failures, windowMs, threshold });
            // W26: contabiliza abertura do circuit breaker
            if (this.sessionMetrics.has(sessionId)) {
                this.sessionMetrics.get(sessionId).circuit_breaker_trips++;
            }
        }
    }

    _resetBackendCircuit(sessionId) {
        const cb = this.circuitBreakers.get(sessionId);
        if (!cb) return;
        const wasOpen = cb.isOpen;
        cb.failures = 0;
        cb.firstFailureAt = null;
        cb.isOpen = false;
        cb.openedAt = null;
        if (wasOpen) logger.info({ sessionId }, 'Circuit breaker fechado após resposta bem-sucedida');
    }

    // =========================================================
    // W25 — RECONEXÃO MANUAL (sem limpar auth)
    // =========================================================

    async reconnectSession(sessionId) {
        logger.info({ sessionId }, 'Reconexão manual solicitada');

        // Fecha socket existente sem limpar auth
        const sock = this.activeSessions.get(sessionId);
        if (sock) {
            try { sock.end(undefined); } catch (_) {}
            this.activeSessions.delete(sessionId);
        }

        // Limpa estado transitório
        this.qrCodeCache.delete(sessionId);
        this._clearQrScanTimeout(sessionId);
        this.reconnectAttempts.delete(sessionId);

        // W26: incrementa contador de reconexões
        if (!this.sessionMetrics.has(sessionId)) this._initMetrics(sessionId);
        this.sessionMetrics.get(sessionId).reconnect_count++;

        // Cria nova conexão reaproveitando auth existente no banco
        return this.createSession(sessionId);
    }

    async sendFailureWebhook(sessionId, config, reason) {
        const webhookUrl = config.webhook_url;
        if (!webhookUrl) {
            logger.warn({ sessionId }, 'webhook_url não configurada — webhook de falha não enviado');
            return;
        }

        const payload = {
            event: 'session_failed',
            session_id: sessionId,
            tenant_id: config.api_key_id,
            reason,
            timestamp: new Date().toISOString()
        };

        const payloadString = JSON.stringify(payload);

        const headers = { 'Content-Type': 'application/json' };

        const apiKey = config.metadata?.webhook_auth_token || process.env.API_SECRET_KEY;
        if (apiKey) headers['x-api-key'] = apiKey;

        const signatureKey = config.webhook_signature_key || process.env.WEBHOOK_SIGNATURE_KEY;
        if (signatureKey) {
            headers['X-Webhook-Signature'] = generateWebhookSignature(payloadString, signatureKey);
        }

        try {
            await axios.post(webhookUrl, payloadString, { headers, timeout: 10000 });
            logger.info({ sessionId, reason }, 'Webhook de falha de sessão enviado com sucesso');
        } catch (err) {
            logger.error({ err: err.message, sessionId }, 'Falha ao enviar webhook de falha de sessão');
        }
    }

    async logEvent(sessionId, eventType, details = {}) {
        // Implementação simplificada do log
        try {
            await pool.query(
                `INSERT INTO session_logs (session_id, event_type, details) VALUES ($1, $2, $3)`,
                [sessionId, eventType, JSON.stringify(details)]
            );
        } catch (error) {
            logger.error({ err: error }, 'Erro ao registrar log');
        }
    }
}

module.exports = new SessionManager();