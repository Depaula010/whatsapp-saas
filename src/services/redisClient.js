// ========================================
// Redis Client — Singleton
// ========================================
// Cliente ioredis reutilizável. Expõe `client` (ioredis) e `isAvailable`
// para que outros módulos usem Redis sem re-conectar a cada chamada.
// Se Redis não estiver configurado ou falhar na conexão, isAvailable = false
// e as features que dependem do Redis fazem fallback síncrono.

const Redis = require('ioredis');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let client = null;
let isAvailable = false;

function createClient() {
    const host = process.env.REDIS_HOST;
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    if (!host) {
        logger.warn('[REDIS] REDIS_HOST não configurado — Redis desabilitado (modo síncrono).');
        return;
    }

    const redisClient = new Redis({
        host,
        port,
        password,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy(times) {
            if (times > 10) {
                logger.error('[REDIS] Máximo de tentativas de reconexão atingido — desabilitando Redis.');
                isAvailable = false;
                return null; // para de tentar
            }
            return Math.min(times * 500, 10000);
        },
    });

    redisClient.on('connect', () => {
        isAvailable = true;
        logger.info('[REDIS] Conectado com sucesso.');
    });

    redisClient.on('ready', () => {
        isAvailable = true;
    });

    redisClient.on('error', (err) => {
        if (isAvailable) {
            logger.error({ err }, '[REDIS] Erro de conexão — Redis indisponível.');
        }
        isAvailable = false;
    });

    redisClient.on('close', () => {
        isAvailable = false;
    });

    redisClient.on('reconnecting', () => {
        logger.debug('[REDIS] Reconectando...');
    });

    redisClient.connect().catch((err) => {
        logger.error({ err }, '[REDIS] Falha ao conectar — Redis desabilitado.');
        isAvailable = false;
    });

    client = redisClient;
}

createClient();

module.exports = {
    get client() { return client; },
    get isAvailable() { return isAvailable; },
};
