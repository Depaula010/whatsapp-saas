// ========================================
// Validação de URLs e Inputs
// ========================================

const dns = require('dns').promises;

// Bloquear IPs privados e reservados — usado tanto no hostname literal
// quanto em cada IP que ele resolver via DNS (ver validateWebhookUrl).
const BLOCKED_IP_PATTERNS = [
    /^127\./,                          // Loopback
    /^10\./,                           // Classe A privado
    /^172\.(1[6-9]|2[0-9]|3[01])\./,  // Classe B privado
    /^192\.168\./,                     // Classe C privado
    /^169\.254\./,                     // Link-local
    /^0\./,                            // Rede zero
    /^::1$/,                           // IPv6 loopback
    /^fc00:/i,                         // IPv6 privado
    /^fe80:/i,                         // IPv6 link-local
    /^localhost$/i,                    // localhost
];

/**
 * Valida webhook URL para prevenir SSRF.
 * Bloqueia protocolos inseguros, IPs privados/reservados (literais ou
 * resolvidos via DNS) e hostnames de rótulo único (ex: nomes de container
 * Docker como "postgres-central", que não são domínios públicos válidos
 * mas resolvem normalmente dentro da rede interna).
 * @param {string} url - URL para validar
 * @returns {Promise<boolean>} true se URL é segura
 */
async function validateWebhookUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    // Apenas HTTP/HTTPS permitidos
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return false;
    }

    // Em desenvolvimento, localhost é permitido
    if (process.env.NODE_ENV === 'development') {
        return true;
    }

    const hostname = parsed.hostname;

    // Hostname de rótulo único (sem "." nem ":") é sempre um nome interno
    // (container Docker, host da rede local) — nenhum domínio público é assim.
    if (!hostname.includes('.') && !hostname.includes(':')) {
        return false;
    }

    for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(hostname)) {
            return false;
        }
    }

    // Resolve o hostname e bloqueia se qualquer IP resolvido cair em faixa
    // privada/reservada — fecha o caso de um domínio público apontando (ou
    // sendo re-apontado depois, DNS rebinding) para um IP interno.
    try {
        const addresses = await dns.lookup(hostname, { all: true });
        if (addresses.length === 0) return false;

        for (const { address } of addresses) {
            if (BLOCKED_IP_PATTERNS.some(pattern => pattern.test(address))) {
                return false;
            }
        }
    } catch {
        return false; // não resolveu — mais seguro tratar como inválido
    }

    return true;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida se uma string é um UUID bem formado.
 * Usar antes de repassar um :id de rota para uma query em coluna UUID —
 * o Postgres lança erro de tipo (não tratado = 500) para valores inválidos.
 * @param {string} value
 * @returns {boolean}
 */
function isValidUUID(value) {
    return typeof value === 'string' && UUID_REGEX.test(value);
}

module.exports = {
    validateWebhookUrl,
    isValidUUID
};
