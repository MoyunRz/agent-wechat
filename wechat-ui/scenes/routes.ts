// The scene harness opens URL-addressable views, so it reads the same route
// table the application routes with. Re-exported rather than duplicated: the
// listing in interfaces/ui is generated from this file.
//
// This file must stay free of TypeScript-only runtime syntax (enums, parameter
// properties): the scene listing imports it with Node's type stripping.
export * from '../src/platform/routes.ts'
