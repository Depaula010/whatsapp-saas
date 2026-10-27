// ========================================
// Auth State para Baileys (Multi-Sessão) - CORRIGIDO v2
// ========================================
// Gerencia estado de autenticação do Baileys no PostgreSQL por session_uuid

const { initAuthCreds, makeCacheableSignalKeyStore, proto } = require('@whiskeysockets/baileys');
const { parseKeyDataKey, buildKeyDataKey } = require('./keyStoreLayout');
const { pool } = require('../config/database');
const { encryptAuthData, decryptAuthData } = require('../utils/crypto');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ====================================================================
// SERIALIZAÇÃO DE BUFFERS - Implementação própria
// Como o Baileys usa ESM e nosso projeto usa CommonJS, implementamos
// nosso próprio replacer/reviver para lidar com Buffers
// ====================================================================

/**
 * Converte Buffers para Base64 ao salvar em JSON
 */
const bufferReplacer = (key, value) => {
    if (value && typeof value === 'object') {
        if (Buffer.isBuffer(value)) {
            return {
                type: 'Buffer',
                data: value.toString('base64')
            };
        }
        // Suporta Uint8Array também
        if (value.constructor && value.constructor.name === 'Uint8Array') {
            return {
                type: 'Buffer',
                data: Buffer.from(value).toString('base64')
            };
        }
    }
    return value;
};

/**
 * Converte Base64 de volta para Buffers ao ler JSON
 */
const bufferReviver = (key, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer') {
        if (Array.isArray(value.data)) {
            // Formato antigo: array de bytes
            return Buffer.from(value.data);
        }
        if (typeof value.data === 'string') {
            // Formato novo: base64 string
            return Buffer.from(value.data, 'base64');
        }
    }
    return value;
};

/**
 * Cria auth state para uma sessão específica
 * Compatível com baileys useAuthState
 *
 * @param {string} sessionUuid - UUID da sessão
 * @returns {Promise<{state: {creds: any, keys: any}, saveCreds: Function, loadCreds: Function, clearCreds: Function}>}
 */
async function createAuthState(sessionUuid) {
    // Identificador para a coluna session_id (NOT NULL, legado)
    const sessionId = `session_${sessionUuid}`;

    // Objeto que mantém referência mutável das credenciais
    const authState = {
        creds: initAuthCreds(),
        keys: {}
    };

    /**
     * Upsert genérico: UPDATE primeiro, INSERT se não existir
     * Com retry para evitar race conditions
     */
    const upsertAuthData = async (dataKey, dataValue, retries = 3) => {
        // Cifra antes de gravar — quem só tem acesso ao banco não reconstrói
        // a sessão do WhatsApp sem a AUTH_ENCRYPTION_KEY (fica só no .env).
        const encryptedValue = encryptAuthData(dataValue);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const updateResult = await pool.query(
                    `UPDATE baileys_auth SET data_value = $3, updated_at = NOW()
                     WHERE session_uuid = $1 AND data_key = $2`,
                    [sessionUuid, dataKey, encryptedValue]
                );

                if (updateResult.rowCount === 0) {
                    await pool.query(
                        `INSERT INTO baileys_auth (session_id, session_uuid, data_key, data_value)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (session_uuid, data_key) DO UPDATE SET data_value = $4, updated_at = NOW()`,
                        [sessionId, sessionUuid, dataKey, encryptedValue]
                    );
                }
                return; // Sucesso, sai do loop
            } catch (error) {
                if (error.code === '23505' && attempt < retries) {
                    // Duplicate key - tentar novamente com UPDATE
                    logger.debug({ dataKey, attempt }, 'Retrying upsert due to race condition');
                    continue;
                }
                throw error;
            }
        }
    };

    /**
     * Carrega credenciais do banco de dados
     */
    const loadCreds = async () => {
        try {
            const result = await pool.query(
                `SELECT data_key, data_value
                 FROM baileys_auth
                 WHERE session_uuid = $1`,
                [sessionUuid]
            );

            if (result.rows.length === 0) {
                logger.info({ sessionUuid }, 'Nenhuma credencial encontrada - usando credenciais novas');
                return; // Sem credenciais = usar initAuthCreds (já inicializado)
            }

            let credsParsed = false;

            for (const row of result.rows) {
                const { data_key, data_value } = row;

                if (!data_value) continue;

                try {
                    // Decifra antes de deserializar (ver upsertAuthData)
                    const decryptedValue = decryptAuthData(data_value);
                    // Usar nosso bufferReviver para deserialização correta
                    const parsedValue = JSON.parse(decryptedValue, bufferReviver);

                    if (data_key === 'creds') {
                        // Mesclar com creds existentes (mantém campos que não foram salvos)
                        Object.assign(authState.creds, parsedValue);
                        credsParsed = true;
                    } else if (data_key.startsWith('key-')) {
                        // Chaves do Signal: mapa plano authState.keys[categoria][id]. O nome tem hífen (categoria) e pode ter
                        // ponto/hífen (id), então o prefixo é reconhecido por keyStoreLayout (antes quebrava em "-" e deixava
                        // pre-keys e sessões ilegíveis depois de qualquer reconexão).
                        const parsedKey = parseKeyDataKey(data_key);
                        if (!parsedKey) {
                            logger.warn({ dataKey: data_key }, 'Chave com categoria desconhecida - ignorada');
                            continue;
                        }
                        if (!authState.keys[parsedKey.category]) {
                            authState.keys[parsedKey.category] = {};
                        }
                        authState.keys[parsedKey.category][parsedKey.id] = parsedValue;
                    }
                } catch (parseError) {
                    logger.error({ err: parseError, dataKey: data_key }, 'Erro ao parsear auth data');
                    // Se falhar ao parsear as credenciais principais, isso é crítico
                    if (data_key === 'creds') {
                        throw new Error(`Credenciais corrompidas: ${parseError.message}`);
                    }
                }
            }

            // Validar se as credenciais carregadas são válidas
            if (credsParsed) {
                if (!authState.creds.noiseKey || !authState.creds.signedIdentityKey) {
                    throw new Error('Credenciais incompletas: faltam campos essenciais (noiseKey ou signedIdentityKey)');
                }
            }

            logger.debug({ sessionUuid, keysLoaded: result.rows.length, credsParsed }, 'Auth state carregado');
        } catch (error) {
            logger.error({ err: error, sessionUuid }, 'Erro ao carregar auth state');
            throw error;
        }
    };

    /**
     * Salva as credenciais no banco de dados
     * CRÍTICO: Usa bufferReplacer para serialização correta de Buffers
     */
    const saveCreds = async () => {
        try {
            // Validar se as credenciais não estão vazias
            if (!authState.creds || !authState.creds.noiseKey || !authState.creds.signedIdentityKey) {
                logger.warn({ sessionUuid }, 'Tentativa de salvar credenciais incompletas - ignorando');
                return;
            }

            const serializedCreds = JSON.stringify(authState.creds, bufferReplacer);

            // Validar se a serialização funcionou
            if (serializedCreds.length < 100) { // Credenciais válidas sempre são maiores
                logger.error({ sessionUuid, size: serializedCreds.length }, 'Credenciais serializadas muito pequenas - possível corrupção');
                return;
            }

            await upsertAuthData('creds', serializedCreds);
            logger.debug({ sessionUuid, size: serializedCreds.length }, 'Credenciais salvas com sucesso');
        } catch (error) {
            logger.error({ err: error, sessionUuid }, 'ERRO CRÍTICO ao salvar credenciais');
            // Não lançar erro para não interromper o fluxo do Baileys
        }
    };

    /**
     * Salva uma chave específica
     * @param {string} keyPath - Caminho da chave (ex: 'app-state-sync-key-AAAAAAA')
     * @param {*} value - Valor da chave
     */
    const saveKey = async (dataKey, value) => {
        const keyPath = dataKey;

        try {
            if (value === null || value === undefined) {
                // Deletar chave
                await pool.query(
                    `DELETE FROM baileys_auth WHERE session_uuid = $1 AND data_key = $2`,
                    [sessionUuid, dataKey]
                );
            } else {
                // Inserir/atualizar chave com bufferReplacer
                await upsertAuthData(dataKey, JSON.stringify(value, bufferReplacer));
            }
        } catch (error) {
            logger.error({ err: error, keyPath }, 'Erro ao salvar key');
        }
    };

    /**
     * Limpa todas as credenciais da sessão
     */
    const clearCreds = async () => {
        await pool.query(
            `DELETE FROM baileys_auth WHERE session_uuid = $1`,
            [sessionUuid]
        );

        // Resetar para valores iniciais
        authState.creds = initAuthCreds();
        authState.keys = {};

        logger.info({ sessionUuid }, 'Auth state limpo');
    };

    // Criar signal key store com cache
    const signalKeyStore = makeCacheableSignalKeyStore(
        {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = authState.keys[type]?.[id];
                    if (value === undefined || value === null) {
                        continue;
                    }
                    if (type === 'app-state-sync-key') {
                        // Mesmo tratamento do useMultiFileAuthState do Baileys.
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                // Processar todas as keys em batch para evitar race conditions
                const savePromises = [];

                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];

                        // Atualizar em memória primeiro (null/undefined = chave apagada)
                        if (!authState.keys[category]) {
                            authState.keys[category] = {};
                        }
                        if (value === null || value === undefined) {
                            delete authState.keys[category][id];
                        } else {
                            authState.keys[category][id] = value;
                        }

                        // Agendar salvamento no banco
                        savePromises.push(saveKey(buildKeyDataKey(category, id), value));
                    }
                }

                // Esperar todos os salvamentos completarem
                await Promise.allSettled(savePromises);
            }
        },
        pino({ level: 'silent' }) // Logger silencioso para key store
    );

    return {
        state: {
            creds: authState.creds,
            keys: signalKeyStore
        },
        saveCreds,
        loadCreds,
        clearCreds
    };
}

/**
 * Verifica se uma sessão tem credenciais salvas
 * @param {string} sessionUuid - UUID da sessão
 * @returns {Promise<boolean>} true se existem credenciais
 */
async function hasAuthState(sessionUuid) {
    const result = await pool.query(
        `SELECT COUNT(*) as count
         FROM baileys_auth
         WHERE session_uuid = $1 AND data_key = 'creds'`,
        [sessionUuid]
    );

    return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Remove auth state de uma sessão
 * @param {string} sessionUuid - UUID da sessão
 */
async function removeAuthState(sessionUuid) {
    await pool.query(
        `DELETE FROM baileys_auth WHERE session_uuid = $1`,
        [sessionUuid]
    );
    logger.info({ sessionUuid }, 'Auth state removido');
}

module.exports = {
    createAuthState,
    hasAuthState,
    removeAuthState
};
