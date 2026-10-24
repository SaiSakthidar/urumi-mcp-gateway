import pg from "pg";

// Connection settings come from PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
export const pool = new pg.Pool({ max: 10 });
