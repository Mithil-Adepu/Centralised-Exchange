import { pool } from "./pool";

export type DbUser = {
    id: string;
    email: string;
    passwordHash: string;
    emailVerified: boolean;
    status: string;
    createdAt: Date;
    updatedAt: Date;
};

export type DbSession = {
    sessionId: string;
    userId: string;
    refreshTokenHash: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    expiresAt: Date;
};


function mapUser(row: any): DbUser {
    return {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        emailVerified: Boolean(row.email_verified),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapSession(row: any): DbSession {
    return {
        sessionId: row.session_id,
        userId: row.user_id,
        refreshTokenHash: row.refresh_token_hash,
        ipAddress: row.ip_address || null,
        userAgent: row.user_agent || null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
    };
}

/* ═══════════════════════════════════════════════════════════════
   User Queries
   ═══════════════════════════════════════════════════════════════ */

export async function getUserByEmail(email: string): Promise<DbUser | null> {
    const result = await pool.query(
        "SELECT id, email, password_hash, email_verified, status, created_at, updated_at FROM users WHERE email = $1",
        [email]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return mapUser(result.rows[0]);
}

export async function getUserById(userId: string): Promise<DbUser | null> {
    const result = await pool.query(
        "SELECT id, email, password_hash, email_verified, status, created_at, updated_at FROM users WHERE id = $1",
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return mapUser(result.rows[0]);
}

export async function createUser(user: { id: string; email: string; passwordHash: string }) {
    const result = await pool.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, password_hash, email_verified, status, created_at, updated_at",
        [user.id, user.email, user.passwordHash]
    );
    return mapUser(result.rows[0]);
}

/* ═══════════════════════════════════════════════════════════════
   Role Queries
   ═══════════════════════════════════════════════════════════════ */

export async function getUserRoles(userId: string): Promise<string[]> {
    const result = await pool.query(
        "SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1",
        [userId]
    );

    return result.rows.map((row: any) => row.name).filter((role: any) => typeof role === "string");
}

export async function assignRole(userId: string, roleName: string) {
    const roleResult = await pool.query(
        "SELECT id FROM roles WHERE name = $1",
        [roleName]
    );

    if (roleResult.rows.length === 0) {
        return;
    }

    const roleId = roleResult.rows[0].id;
    await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, roleId]
    );
}

/* ═══════════════════════════════════════════════════════════════
   Session Queries
   ═══════════════════════════════════════════════════════════════ */

export async function createSession(session: {
    sessionId: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
}) {
    await pool.query(
        `INSERT INTO auth_sessions (session_id, user_id, refresh_token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            session.sessionId,
            session.userId,
            session.refreshTokenHash,
            session.ipAddress || null,
            session.userAgent || null,
            session.expiresAt,
        ]
    );
}

export async function getSessionById(sessionId: string): Promise<DbSession | null> {
    const result = await pool.query(
        "SELECT session_id, user_id, refresh_token_hash, ip_address, user_agent, created_at, expires_at FROM auth_sessions WHERE session_id = $1 AND expires_at > NOW()",
        [sessionId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return mapSession(result.rows[0]);
}

export async function deleteSession(sessionId: string) {
    await pool.query("DELETE FROM auth_sessions WHERE session_id = $1", [sessionId]);
}

/**
 * Count active (non-expired) sessions for a user.
 */
export async function countSessionsByUser(userId: string): Promise<number> {
    const result = await pool.query(
        "SELECT COUNT(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND expires_at > NOW()",
        [userId]
    );

    return result.rows[0]?.count || 0;
}

/**
 * Delete the oldest sessions for a user, keeping only `keepCount` most recent.
 * Used to enforce the concurrent session limit.
 */
export async function deleteOldestSessions(userId: string, keepCount: number): Promise<number> {
    const result = await pool.query(
        `DELETE FROM auth_sessions
         WHERE session_id IN (
             SELECT session_id FROM auth_sessions
             WHERE user_id = $1 AND expires_at > NOW()
             ORDER BY created_at ASC
             LIMIT GREATEST(0, (
                 SELECT COUNT(*) FROM auth_sessions WHERE user_id = $1 AND expires_at > NOW()
             ) - $2)
         )`,
        [userId, keepCount]
    );

    return result.rowCount || 0;
}

/**
 * List active sessions for a user (for the "Active Sessions" UI).
 */
export async function getActiveSessions(userId: string): Promise<DbSession[]> {
    const result = await pool.query(
        `SELECT session_id, user_id, refresh_token_hash, ip_address, user_agent, created_at, expires_at
         FROM auth_sessions
         WHERE user_id = $1 AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [userId]
    );

    return result.rows.map(mapSession);
}

/**
 * Purge all expired sessions from the database.
 * Called periodically by the session cleanup cron.
 */
export async function deleteExpiredSessions(): Promise<number> {
    const result = await pool.query(
        "DELETE FROM auth_sessions WHERE expires_at <= NOW()"
    );

    return result.rowCount || 0;
}
