/// <reference types="vite/client" />

// Brings in the types for import.meta.env. The root tsconfig pins `types` to
// ["node"] for the server and db code, which switches off automatic @types
// discovery -- so the browser half declares what it needs explicitly rather than
// widening the global type surface for every workspace.
