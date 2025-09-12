// functions/.eslintrc.cjs
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier', // keep last
  ],
  parserOptions: {
    sourceType: 'module',
    // Remove "project" for faster/less finicky lint (type-aware rules not needed here)
    // project: ['tsconfig.json', 'tsconfig.dev.json'],
  },
  rules: {
    // Match the advice I gave earlier
    'linebreak-style': 'off',       // no CRLF noise on Windows
    'max-len': 'off',               // avoid 80-char noise
    'valid-jsdoc': 'off',           // Google style used to require this
    'object-curly-spacing': ['error', 'always'], // align with Prettier
    quotes: ['error', 'double'],
    indent: ['error', 2],
  },
  ignorePatterns: [
    'lib/**',
    'generated/**',
    'dist/**',
    'node_modules/**',
  ],
};
