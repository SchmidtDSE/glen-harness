import { defineConfig, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        coverage: {
            // src/vendor/mcp-sdk.js is a pre-bundled third-party artifact, not
            // code we write or test. Spread the defaults so excluding it keeps
            // vitest's built-in exclusions (node_modules, test files, configs).
            exclude: [...coverageConfigDefaults.exclude, 'src/vendor/**'],
        },
    },
});
