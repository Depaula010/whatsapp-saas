// ========================================
// Utilitários de Criptografia
// ========================================
// Geração de API keys, HMAC, hashing

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 10;

/**
 * Gera uma nova API key no formato whatsapp_{env}_{random}
 * @param {string} env - Ambiente (live, test, dev)
 * @returns {string} API key gerada
 */
function generateApiKey(env = 'live') {
    const randomBytes = crypto.randomBytes(32).toString('base64url');
    return `whatsapp_${env}_${randomBytes}`;
}

/**
 * Extrai o prefixo de uma API key (primeiros 16 caracteres)
 * @param {string} apiKey - API key completa
 * @returns {string} Prefixo da key
 */
function extractKeyPrefix(apiKey) {
    if (!apiKey || apiKey.length < 16) {
        throw new Error('API key inválida');
    }
    return apiKey.substring(0, 16);
}

/**
 * Hash uma API key usando bcrypt
 * @param {string} apiKey - API key em plaintext
 * @returns {Promise<string>} Hash bcrypt
 */
async function hashApiKey(apiKey) {
    return bcrypt.hash(apiKey, BCRYPT_ROUNDS);
}

/**
 * Verifica se uma API key corresponde ao hash
 * @param {string} apiKey - API key em plaintext
 * @param {string} hash - Hash bcrypt para comparar
 * @returns {Promise<boolean>} true se corresponder
 */
async function verifyApiKey(apiKey, hash) {
    return bcrypt.compare(apiKey, hash);
}

/**
 * Gera assinatura HMAC-SHA256 para webhook
 * @param {Object} payload - Objeto a ser assinado
 * @param {string} secret - Chave secreta HMAC
 * @returns {string} Assinatura em hexadecimal
 */
function generateWebhookSignature(payload, secret) {
    const payloadString = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);

    return crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');
}

/**
 * Verifica assinatura HMAC de webhook
 * @param {Object} payload - Objeto recebido
 * @param {string} signature - Assinatura fornecida
 * @param {string} secret - Chave secreta HMAC
 * @returns {boolean} true se assinatura válida
 */
function verifyWebhookSignature(payload, signature, secret) {
    const expectedSignature = generateWebhookSignature(payload, secret);
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

/**
 * Gera um UUID v4
 * @returns {string} UUID
 */
function generateUUID() {
    return crypto.randomUUID();
}

/**
 * Gera um token aleatório (para uso geral)
 * @param {number} bytes - Número de bytes aleatórios
 * @returns {string} Token em base64url
 */
function generateRandomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Hash SHA256 de uma string
 * @param {string} data - Dados para hash
 * @returns {string} Hash em hexadecimal
 */
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ========================================
// Criptografia das credenciais do WhatsApp (baileys_auth)
// ========================================
// AES-256-GCM: quem tiver só acesso de leitura ao Postgres não consegue
// reconstruir a sessão do WhatsApp sem a AUTH_ENCRYPTION_KEY (que vive
// somente no .env do servidor, nunca no banco).

const AUTH_ENC_ALGORITHM = 'aes-256-gcm';
const AUTH_ENC_IV_LENGTH = 12; // recomendado para GCM

let cachedAuthKey = null;

/**
 * Deriva uma chave de 32 bytes a partir de AUTH_ENCRYPTION_KEY (qualquer
 * tamanho/formato) via SHA-256, para sempre bater com o requisito do AES-256.
 * @returns {Buffer}
 */
function getAuthEncryptionKey() {
    if (cachedAuthKey) return cachedAuthKey;

    const raw = process.env.AUTH_ENCRYPTION_KEY;

    if (!raw) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('AUTH_ENCRYPTION_KEY não configurada. Obrigatória em produção para cifrar as credenciais do WhatsApp em repouso.');
        }
        // Dev: gera uma chave efêmera (não persiste entre reinícios, mas
        // evita exigir configuração extra em ambiente local descartável).
        cachedAuthKey = crypto.randomBytes(32);
        return cachedAuthKey;
    }

    cachedAuthKey = crypto.createHash('sha256').update(raw).digest();
    return cachedAuthKey;
}

/**
 * Cifra uma string (credenciais/keys do Baileys serializadas) com AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} "iv:authTag:ciphertext" em base64, um único campo TEXT
 */
function encryptAuthData(plaintext) {
    const key = getAuthEncryptionKey();
    const iv = crypto.randomBytes(AUTH_ENC_IV_LENGTH);
    const cipher = crypto.createCipheriv(AUTH_ENC_ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decifra um valor gerado por encryptAuthData.
 * @param {string} stored - "iv:authTag:ciphertext" em base64
 * @returns {string} plaintext original
 */
function decryptAuthData(stored) {
    const [ivB64, authTagB64, dataB64] = stored.split(':');
    if (!ivB64 || !authTagB64 || !dataB64) {
        throw new Error('Formato de dado cifrado inválido');
    }

    const key = getAuthEncryptionKey();
    const decipher = crypto.createDecipheriv(AUTH_ENC_ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final()
    ]);

    return decrypted.toString('utf8');
}

module.exports = {
    generateApiKey,
    extractKeyPrefix,
    hashApiKey,
    verifyApiKey,
    generateWebhookSignature,
    verifyWebhookSignature,
    generateUUID,
    generateRandomToken,
    sha256,
    encryptAuthData,
    decryptAuthData
};
