// Client-safe surface of @relaypay/shared.
//
// The default entry re-exports supabase.js, which holds the service-role
// client and imports node: builtins. Pulling that into a browser bundle
// fails the build outright, and even when it happened to compile it put
// a privileged module one import away from client code.
//
// Anything a React client component needs comes from here instead.
// Nothing exported from this file touches the database, the environment,
// or a node: builtin.

export * from './constants.js';
export * from './seed-enums.js';
export * from './tool-schemas.js';
export * from './redact.js';
export * from './redact-transcript.js';
