// ========================================
// Layout das chaves do Signal no banco (baileys_auth.data_key)
// ========================================
// Cada chave é gravada como `key-<categoria>-<id>`. A categoria pode ter hífen ("pre-key", "app-state-sync-key") e o id também pode
// ter ponto ou hífen (sessões do Signal são "<numero ou lid>.<dispositivo>", ex.: "174350003089528.0"). Por isso o nome não pode ser
// separado por "-" ou "." às cegas: o prefixo é reconhecido pela lista de categorias que o Baileys usa.

const KEY_CATEGORIES = [
    'app-state-sync-version',
    'app-state-sync-key',
    'sender-key-memory',
    'sender-key',
    'identity-key',
    'lid-mapping',
    'device-list',
    'pre-key',
    'session',
    'tctoken',
];

// Mais longas primeiro: "sender-key-memory" precisa ser testada antes de "sender-key".
const BY_LENGTH = [...KEY_CATEGORIES].sort((a, b) => b.length - a.length);

/** `key-<categoria>-<id>` -> { category, id }, ou null se não for uma chave reconhecível. */
function parseKeyDataKey(dataKey) {
    if (typeof dataKey !== 'string' || !dataKey.startsWith('key-')) {
        return null;
    }
    const rest = dataKey.slice('key-'.length);
    for (const category of BY_LENGTH) {
        if (rest.startsWith(`${category}-`) && rest.length > category.length + 1) {
            return { category, id: rest.slice(category.length + 1) };
        }
    }
    return null;
}

/** { category, id } -> `key-<categoria>-<id>`. */
function buildKeyDataKey(category, id) {
    return `key-${category}-${id}`;
}

module.exports = { KEY_CATEGORIES, parseKeyDataKey, buildKeyDataKey };
