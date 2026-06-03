/** @type {import('jest').Config} */
module.exports = {
  displayName: 'time-off',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: '../tsconfig.app.json',
      },
    ],
  },
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/index.ts',
    '!**/main.ts',
    '!**/*.module.ts',
  ],
  coverageDirectory: '../../../coverage',
  testEnvironment: 'node',
  setupFiles: ['../../../test/setup-env.ts'],
};
