// functions/eslint.config.cjs
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  { ignores: ['lib/**', 'dist/**', 'generated/**', 'node_modules/**', 'eslint.config.*', '.eslintrc.*'] },

  js.configs.recommended,

  {
    files: ['src/**/*.{ts,js}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      // <-- this line makes ESLint recognize process, Buffer, console, etc.
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'linebreak-style': 'off',
      'max-len': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      indent: 'off',
      'object-curly-spacing': ['error', 'always'],
      quotes: ['error', 'double'],
    },
  },

  // If any *.cjs files get linted, also give them Node globals
  {
    files: ['*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },

  prettier,
];
