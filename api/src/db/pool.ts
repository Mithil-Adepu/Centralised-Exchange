import { Pool } from "pg";

/* ═══════════════════════════════════════════════════════════════
   Shared PostgreSQL Pool — Single connection pool for the API

   All routes and services should import from here instead of
   creating their own Client/Pool instances.
   ═══════════════════════════════════════════════════════════════ */

const pool = new Pool({
    user: process.env.DB_USER || "your_user",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "my_database",
    password: process.env.DB_PASSWORD || "your_password",
    port: Number(process.env.DB_PORT) || 5433,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
    console.error("PG Pool error:", err);
});

pool.on("connect", () => {
    console.log("PG Pool: new client connected");
});

export { pool };
