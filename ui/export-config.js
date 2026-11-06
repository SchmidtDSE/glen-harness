/**
 * The export settings ChatUI reads when it builds the chat, kept apart from
 * export-report.js so the chat can decide whether to offer the export without
 * loading the report builder and its DuckDB code. export-report.js re-exports
 * everything here.
 */

/**
 * Where the disclosure's "GLEN" link points: the project's deployed page,
 * not its GitHub repo. Apps override it with `export.project_url`.
 */
export const GLEN_PROJECT_URL = 'https://boettiger-lab.github.io/geo-agent/';

/**
 * Default public (anonymous) S3 endpoint for the exported setup block.
 * Mirrors the host that `dataset-catalog.js` strips when it converts asset
 * hrefs to `s3://` paths. Apps on other storage override it with
 * `public_s3_endpoint` in their config.
 */
export const PUBLIC_S3_ENDPOINT = 's3-west.nrp-nautilus.io';

/**
 * Strip a scheme and any trailing slashes from an S3 host, so a config that
 * spells the endpoint as a URL still produces a valid `ENDPOINT '…'`.
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function normalizeS3Host(endpoint) {
    return String(endpoint || PUBLIC_S3_ENDPOINT)
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
}

/**
 * Resolve the app's export settings.
 *
 * Shape in `layers-input.json` (or the deploy-time `config.json`, which wins):
 *
 * ```json
 * "export": { "enabled": false }
 * "export": { "public_s3_endpoint": "minio.example.org" }
 * "export": { "project_url": "https://glen.example.org/" }
 * "export": false
 * ```
 *
 * Opt-*out*: absent config means the export is on, which is what the public
 * apps want. Private deployments turn it off, because the credential scrub
 * strips exactly what their exported queries would need — the recipient gets
 * a document whose code cannot run.
 *
 * `public_s3_endpoint` as a flat top-level key is the older spelling (#367)
 * and is still honoured, with the block winning when both are set.
 *
 * @param {object} [config] - merged app config
 * @returns {{ enabled: boolean, s3Endpoint: string, codeLanguage: string, projectUrl: string }}
 */
export function resolveExportConfig(config = {}) {
    // Deploy-time config.json arrives from k8s, where a boolean can land as
    // the string "false"; treat both spellings as off.
    const isOff = (v) => v === false || v === 'false';

    const block = config?.export;
    const blk = (block && typeof block === 'object') ? block : {};
    const enabled = !isOff(block) && !isOff(blk.enabled);
    const endpoint = blk.public_s3_endpoint || config?.public_s3_endpoint || PUBLIC_S3_ENDPOINT;

    // Which language the exported document opens on. An unknown value falls
    // back to SQL rather than showing an empty document — the reader can
    // still switch in the file.
    const wanted = String(blk.default_code_language ?? 'sql').toLowerCase();
    const codeLanguage = CODE_LANGUAGES.some(l => l.id === wanted) ? wanted : 'sql';

    const projectUrl = blk.project_url || GLEN_PROJECT_URL;

    return { enabled, s3Endpoint: normalizeS3Host(endpoint), codeLanguage, projectUrl };
}

/**
 * Code languages the export can present. SQL is what actually ran; R and
 * Python are thin wrappers around the identical query text, because most of
 * our users can drive R or Python and cannot write SQL — they just don't know
 * that `duckdb` hands SQL straight through in three lines.
 */
export const CODE_LANGUAGES = [
    { id: 'sql', label: 'SQL' },
    { id: 'r', label: 'R' },
    { id: 'python', label: 'Python' },
];
