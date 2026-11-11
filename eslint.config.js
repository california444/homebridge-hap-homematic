import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'semi': ['error', 'always'],
      'eqeqeq': ['error', 'smart'],
      'comma-dangle': ['error', 'always-multiline'],
      'max-len': ['warn', { code: 160 }],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['homebridge-ui/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        btoa: 'readonly',
        console: 'readonly',
        homebridge: 'readonly',
        bootstrap: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-len': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // server.js is the esbuild bundle of server.src.js; lint the source
    // not the inlined output. dist/ is the tsc/esbuild output of src/.
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'references/',
      'ccu-dump/',
      'homebridge-ui/server.js',
    ],
  },
);
