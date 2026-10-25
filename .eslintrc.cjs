module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'script' },
  extends: ['eslint:recommended'],
  rules: { 'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  overrides: [{ files: ['tests/**'], env: { jest: true } }],
};
