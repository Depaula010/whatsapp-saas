'use strict';

// Testa a lógica de retry + HMAC sem instanciar o SessionManager completo
// (que depende do Baileys/PostgreSQL em runtime).
// Extrai a lógica relevante usando o módulo crypto já testado.

const { generateWebhookSignature, verifyWebhookSignature } = require('../../utils/crypto');

// ── Simulação da lógica de _scheduleWebhookRetry ──────────────────────────
// Replica o comportamento exato de sessionManager._scheduleWebhookRetry
// sem depender do processo completo.

function buildRetryHeaders(baseHeaders, payloadString, signatureKey) {
    const headers = { ...baseHeaders };
    if (signatureKey) {
        // W31: recalcula a assinatura fresh — não reutiliza cached header do attempt original
        headers['X-Webhook-Signature'] = generateWebhookSignature(payloadString, signatureKey);
    }
    return headers;
}

// ── Testes W31 ─────────────────────────────────────────────────────────────

describe('W31 — X-Webhook-Signature recalculado em cada retry', () => {
    const SIGNATURE_KEY = 'secret-webhook-key';
    const PAYLOAD = JSON.stringify({ texto: 'olá', numero_remetente: '+5511999990000' });

    const BASE_HEADERS = {
        'Content-Type': 'application/json',
        'x-api-key': 'tenant-api-key-abc123',
        // Nota: X-Webhook-Signature NÃO está nos baseHeaders —
        // é injetado fresh por _scheduleWebhookRetry (W31)
    };

    test('X-Webhook-Signature está presente nos headers do retry', () => {
        const headers = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        expect(headers['X-Webhook-Signature']).toBeDefined();
    });

    test('assinatura calculada no retry é válida para o payload', () => {
        const headers = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        const isValid = verifyWebhookSignature(PAYLOAD, headers['X-Webhook-Signature'], SIGNATURE_KEY);
        expect(isValid).toBe(true);
    });

    test('assinatura do retry é idêntica à do attempt original (payload imutável)', () => {
        // Simula o attempt original
        const originalSig = generateWebhookSignature(PAYLOAD, SIGNATURE_KEY);

        // Simula attempt 1, 2 e 3
        const retry1 = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        const retry2 = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        const retry3 = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);

        expect(retry1['X-Webhook-Signature']).toBe(originalSig);
        expect(retry2['X-Webhook-Signature']).toBe(originalSig);
        expect(retry3['X-Webhook-Signature']).toBe(originalSig);
    });

    test('baseHeaders NÃO é mutado entre retries (spread defensivo)', () => {
        expect(BASE_HEADERS['X-Webhook-Signature']).toBeUndefined();

        buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);

        // BASE_HEADERS deve permanecer sem X-Webhook-Signature
        expect(BASE_HEADERS['X-Webhook-Signature']).toBeUndefined();
    });

    test('sem signatureKey configurada, X-Webhook-Signature não é adicionado', () => {
        const headers = buildRetryHeaders(BASE_HEADERS, PAYLOAD, null);
        expect(headers['X-Webhook-Signature']).toBeUndefined();
    });

    test('outros headers são preservados no retry', () => {
        const headers = buildRetryHeaders(BASE_HEADERS, PAYLOAD, SIGNATURE_KEY);
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['x-api-key']).toBe('tenant-api-key-abc123');
    });
});

// ── Consistência serialização → assinatura ─────────────────────────────────

describe('consistência payload serializado e assinado', () => {
    const SECRET = 'consistency-secret';

    test('assinar string serializada == assinar o objeto (mesmo JSON)', () => {
        const obj = { texto: 'teste', numero_remetente: '+5511912345678' };
        const str = JSON.stringify(obj);

        const sigFromObj = generateWebhookSignature(obj, SECRET);
        const sigFromStr = generateWebhookSignature(str, SECRET);

        expect(sigFromObj).toBe(sigFromStr);
    });

    test('assinatura da string enviada é verificável pelo backend', () => {
        const payload = { texto: 'agendar horário', numero_remetente: '+5511999990001' };
        const payloadString = JSON.stringify(payload);

        // Bot: assina a STRING serializada
        const sig = generateWebhookSignature(payloadString, SECRET);

        // Backend: valida usando a STRING recebida (bytes exatos do body HTTP)
        const isValid = verifyWebhookSignature(payloadString, sig, SECRET);
        expect(isValid).toBe(true);
    });
});
