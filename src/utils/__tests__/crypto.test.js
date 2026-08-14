'use strict';

const crypto = require('crypto');
const {
    generateWebhookSignature,
    verifyWebhookSignature,
    generateApiKey,
    extractKeyPrefix,
    generateUUID,
    generateRandomToken,
    sha256,
} = require('../crypto');

// ── generateWebhookSignature ────────────────────────────────────────────────

describe('generateWebhookSignature', () => {
    const SECRET = 'test-secret-key-32-bytes-long!!';

    test('retorna hex de 64 chars (SHA-256 → 32 bytes)', () => {
        const sig = generateWebhookSignature({ foo: 'bar' }, SECRET);
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    test('resultado é determinístico para mesmo payload + chave', () => {
        const payload = JSON.stringify({ a: 1, b: 'dois' });
        expect(generateWebhookSignature(payload, SECRET))
            .toBe(generateWebhookSignature(payload, SECRET));
    });

    test('resultado muda se o payload mudar', () => {
        const sig1 = generateWebhookSignature({ v: 1 }, SECRET);
        const sig2 = generateWebhookSignature({ v: 2 }, SECRET);
        expect(sig1).not.toBe(sig2);
    });

    test('resultado muda se a chave mudar', () => {
        const payload = { x: 'y' };
        const sig1 = generateWebhookSignature(payload, 'chave-a');
        const sig2 = generateWebhookSignature(payload, 'chave-b');
        expect(sig1).not.toBe(sig2);
    });

    test('string e objeto produzem a mesma assinatura quando serialização é igual', () => {
        const obj = { texto: 'oi', numero_remetente: '+5511999999999' };
        const str = JSON.stringify(obj);
        // generateWebhookSignature faz JSON.stringify internamente quando recebe objeto
        expect(generateWebhookSignature(obj, SECRET))
            .toBe(generateWebhookSignature(str, SECRET));
    });

    test('bate com implementação Node.js crypto manual', () => {
        const payload = 'hello world';
        const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
        expect(generateWebhookSignature(payload, SECRET)).toBe(expected);
    });
});

// ── verifyWebhookSignature ──────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
    const SECRET = 'verify-secret';
    const PAYLOAD = { evento: 'mensagem', from: '+5511912345678' };

    test('retorna true para assinatura correta', () => {
        const sig = generateWebhookSignature(PAYLOAD, SECRET);
        expect(verifyWebhookSignature(PAYLOAD, sig, SECRET)).toBe(true);
    });

    test('retorna false para assinatura errada', () => {
        const sig = 'a'.repeat(64); // hex válido, mas incorreto
        expect(verifyWebhookSignature(PAYLOAD, sig, SECRET)).toBe(false);
    });

    test('retorna false quando o payload é diferente do assinado', () => {
        const sig = generateWebhookSignature({ evento: 'outro' }, SECRET);
        expect(verifyWebhookSignature(PAYLOAD, sig, SECRET)).toBe(false);
    });
});

// ── W31 — assinatura recalculada (não cacheada) ─────────────────────────────

describe('W31 — assinatura recalculada a cada attempt', () => {
    const SECRET = 'session-secret';

    test('assinaturas de retries são iguais às do attempt original (mesmo payload)', () => {
        const payload = JSON.stringify({ texto: 'teste', numero_remetente: '+5511999990000' });

        const sigOriginal = generateWebhookSignature(payload, SECRET);
        const sigRetry1   = generateWebhookSignature(payload, SECRET);
        const sigRetry2   = generateWebhookSignature(payload, SECRET);

        // Cada retry recalcula e deve produzir o mesmo resultado (payload imutável)
        expect(sigRetry1).toBe(sigOriginal);
        expect(sigRetry2).toBe(sigOriginal);
    });

    test('assinatura muda se o payload mudar entre attempts (robustez futura)', () => {
        const payloadV1 = JSON.stringify({ texto: 'v1', attempt: 1 });
        const payloadV2 = JSON.stringify({ texto: 'v1', attempt: 2 });

        const sig1 = generateWebhookSignature(payloadV1, SECRET);
        const sig2 = generateWebhookSignature(payloadV2, SECRET);

        // Garante que recalcular não "congela" o valor — mudanças no payload refletem na assinatura
        expect(sig1).not.toBe(sig2);
    });
});

// ── Outros utilitários ──────────────────────────────────────────────────────

describe('generateApiKey', () => {
    test('começa com whatsapp_live_', () => {
        expect(generateApiKey()).toMatch(/^whatsapp_live_/);
    });

    test('prefixo personalizado é aplicado', () => {
        expect(generateApiKey('test')).toMatch(/^whatsapp_test_/);
    });

    test('keys geradas são únicas', () => {
        const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
        expect(keys.size).toBe(100);
    });
});

describe('extractKeyPrefix', () => {
    test('retorna os primeiros 16 caracteres', () => {
        const key = 'whatsapp_live_ABCDE12345678901234';
        expect(extractKeyPrefix(key)).toBe('whatsapp_live_AB');
    });

    test('lança erro para key muito curta', () => {
        expect(() => extractKeyPrefix('curta')).toThrow();
    });
});

describe('generateUUID', () => {
    test('retorna UUID v4 válido', () => {
        const uuid = generateUUID();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('UUIDs gerados são únicos', () => {
        const uuids = new Set(Array.from({ length: 100 }, generateUUID));
        expect(uuids.size).toBe(100);
    });
});

describe('generateRandomToken', () => {
    test('retorna string não vazia', () => {
        expect(generateRandomToken()).toBeTruthy();
    });

    test('tokens gerados são únicos', () => {
        const tokens = new Set(Array.from({ length: 50 }, () => generateRandomToken()));
        expect(tokens.size).toBe(50);
    });
});

describe('sha256', () => {
    test('produz hash hex de 64 chars', () => {
        expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
    });

    test('é determinístico', () => {
        expect(sha256('abc')).toBe(sha256('abc'));
    });

    test('bate com Node.js crypto manual', () => {
        const data = 'agenda inteligente';
        const expected = crypto.createHash('sha256').update(data).digest('hex');
        expect(sha256(data)).toBe(expected);
    });
});
