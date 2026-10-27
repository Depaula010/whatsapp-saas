'use strict';

// Regressão: depois de uma reconexão (novo createAuthState + loadCreds) as chaves do Signal gravadas antes precisam voltar.
// O código antigo aninhava por "-" ao carregar e procurava por "." ao ler, então pre-keys ("pre-key") e sessões ("<lid>.0")
// nunca eram achadas: "Invalid PreKey ID" / "No session record" a cada reconexão.

const { parseKeyDataKey, buildKeyDataKey, KEY_CATEGORIES } = require('../keyStoreLayout');

// "Banco" em memória no lugar do pg: só as 4 consultas que o authState faz.
const mockRows = new Map();
jest.mock('../../config/database', () => ({
    pool: {
        query: jest.fn(async (sql, params) => {
            const text = sql.replace(/\s+/g, ' ').trim();
            if (text.startsWith('UPDATE baileys_auth')) {
                const [, key, value] = params;
                if (!mockRows.has(key)) return { rowCount: 0, rows: [] };
                mockRows.set(key, value);
                return { rowCount: 1, rows: [] };
            }
            if (text.startsWith('INSERT INTO baileys_auth')) {
                const [, , key, value] = params;
                mockRows.set(key, value);
                return { rowCount: 1, rows: [] };
            }
            if (text.startsWith('DELETE FROM baileys_auth')) {
                if (params.length === 2) mockRows.delete(params[1]);
                else mockRows.clear();
                return { rowCount: 1, rows: [] };
            }
            if (text.startsWith('SELECT data_key, data_value')) {
                return { rows: [...mockRows].map(([data_key, data_value]) => ({ data_key, data_value })) };
            }
            throw new Error(`consulta não prevista no teste: ${text}`);
        }),
    },
}));

// O Baileys é ESM (o Jest não carrega): dublê mínimo. O que está em teste é o armazenamento das chaves, não a biblioteca.
jest.mock('@whiskeysockets/baileys', () => ({
    initAuthCreds: () => ({ noiseKey: 'n', signedIdentityKey: 's' }),
    makeCacheableSignalKeyStore: (store) => store,
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value) => value } } },
}));

// Sem cifra no teste (a cifra tem teste próprio em utils/__tests__/crypto.test.js).
jest.mock('../../utils/crypto', () => ({
    encryptAuthData: (value) => value,
    decryptAuthData: (value) => value,
}));

const { createAuthState } = require('../authState');

describe('keyStoreLayout', () => {
    test.each([
        ['key-pre-key-12', 'pre-key', '12'],
        ['key-session-174350003089528.0', 'session', '174350003089528.0'],
        ['key-session-553194001072.0', 'session', '553194001072.0'],
        ['key-sender-key-120363029377019555@g.us--174350003089528@lid--0', 'sender-key', '120363029377019555@g.us--174350003089528@lid--0'],
        ['key-sender-key-memory-120363029377019555@g.us', 'sender-key-memory', '120363029377019555@g.us'],
        ['key-app-state-sync-key-AAAAAKx-9', 'app-state-sync-key', 'AAAAAKx-9'],
        ['key-app-state-sync-version-regular_high', 'app-state-sync-version', 'regular_high'],
        ['key-lid-mapping-5531999990001', 'lid-mapping', '5531999990001'],
    ])('%s -> %s / %s', (dataKey, category, id) => {
        expect(parseKeyDataKey(dataKey)).toEqual({ category, id });
        expect(buildKeyDataKey(category, id)).toBe(dataKey);
    });

    test('o que não é chave reconhecível devolve null', () => {
        expect(parseKeyDataKey('creds')).toBeNull();
        expect(parseKeyDataKey('key-categoria-nova-1')).toBeNull();
        expect(parseKeyDataKey('key-pre-key-')).toBeNull();
        expect(parseKeyDataKey(undefined)).toBeNull();
    });

    test('toda categoria conhecida faz ida e volta', () => {
        for (const category of KEY_CATEGORIES) {
            expect(parseKeyDataKey(buildKeyDataKey(category, 'x-1.2'))).toEqual({ category, id: 'x-1.2' });
        }
    });
});

describe('createAuthState: chaves sobrevivem a uma reconexão', () => {
    beforeEach(() => mockRows.clear());

    async function reconnect() {
        // Novo processo/reconexão: novo auth state, lido só do "banco".
        const fresh = await createAuthState('sessao-teste');
        await fresh.loadCreds();
        return fresh.state.keys;
    }

    test('sessão do Signal com id "<lid>.<dispositivo>" e pre-key voltam depois de reconectar', async () => {
        const first = await createAuthState('sessao-teste');
        const sessionRecord = Buffer.from('registro-da-sessao');
        const preKey = { private: Buffer.from('priv'), public: Buffer.from('pub') };
        await first.state.keys.set({
            session: { '174350003089528.0': sessionRecord, '553194001072.0': Buffer.from('outra') },
            'pre-key': { 12: preKey },
        });

        const keys = await reconnect();

        const sessions = await keys.get('session', ['174350003089528.0', '553194001072.0']);
        expect(Buffer.from(sessions['174350003089528.0'] ?? [])).toEqual(sessionRecord);
        expect(sessions['553194001072.0']).toBeDefined();

        const preKeys = await keys.get('pre-key', ['12']);
        expect(Buffer.from(preKeys['12'].private)).toEqual(Buffer.from('priv'));
        expect(Buffer.from(preKeys['12'].public)).toEqual(Buffer.from('pub'));
    });

    test('chave de sender-key de grupo (id com @ e hífens) volta', async () => {
        const first = await createAuthState('sessao-teste');
        const id = '120363029377019555@g.us--174350003089528@lid--0';
        await first.state.keys.set({ 'sender-key': { [id]: Buffer.from('sk') } });

        const stored = await (await reconnect()).get('sender-key', [id]);

        expect(Buffer.from(stored[id])).toEqual(Buffer.from('sk'));
    });

    test('chave apagada (null) não volta depois de reconectar', async () => {
        const first = await createAuthState('sessao-teste');
        await first.state.keys.set({ 'pre-key': { 7: { private: Buffer.from('a'), public: Buffer.from('b') } } });
        await first.state.keys.set({ 'pre-key': { 7: null } });

        const stored = await (await reconnect()).get('pre-key', ['7']);

        expect(stored['7']).toBeUndefined();
    });

    test('id que não existe devolve vazio (não explode)', async () => {
        const stored = await (await reconnect()).get('session', ['999.0']);

        expect(stored).toEqual({});
    });
});
