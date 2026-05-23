/**
 * Vitest setup. Runs once before any test file.
 *
 * - jest-dom matchers (toBeInTheDocument etc.)
 * - happy-dom provides TextEncoder, crypto.subtle, etc. natively; no
 *   polyfills needed.
 */
import '@testing-library/jest-dom/vitest';
