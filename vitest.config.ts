// Copyright 2026 Anjali Garhwal
// Licensed under the Apache License, Version 2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
  },
});
