"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
require("dotenv/config");
var client_js_1 = require("../generated/prisma/client.js");
var adapter_mariadb_1 = require("@prisma/adapter-mariadb");
var connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
    throw new Error('Missing DATABASE_URL environment variable');
}
// Singleton pattern — ensures one DB connection pool across the app
var globalForPrisma = globalThis;
function createPrismaClient() {
    // PrismaMariaDb accepts a raw connection string or PoolConfig
    var adapter = new adapter_mariadb_1.PrismaMariaDb(connectionString);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new client_js_1.PrismaClient({ adapter: adapter });
}
exports.prisma = (_a = globalForPrisma.prisma) !== null && _a !== void 0 ? _a : createPrismaClient();
if (process.env['NODE_ENV'] !== 'production') {
    globalForPrisma.prisma = exports.prisma;
}
