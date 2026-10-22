import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function field(name) {
  if (name === "id") return "id";
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)) throw new Error(`Invalid field: ${name}`);
  return `json_extract(body, '$.${name}')`;
}

function scalar(value) {
  if (value === true || value === "true") return "1";
  if (value === false || value === "false") return "0";
  return String(value);
}

function parseFilter(params) {
  const filter = params.has("filter") ? JSON.parse(params.get("filter")) : {};
  for (const [key, value] of params) {
    if (!key.startsWith("filter[")) continue;
    const keys = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    let current = filter;
    for (const part of keys.slice(0, -1)) current = current[part] ??= {};
    current[keys.at(-1)] = value;
  }
  return filter;
}

function where(filter, args) {
  const clauses = [];
  for (const [name, value] of Object.entries(filter || {})) {
    if (name === "_and" || name === "_or") {
      const children = Object.values(value).map((child) => where(child, args));
      clauses.push(`(${children.join(name === "_and" ? " AND " : " OR ") || "1"})`);
      continue;
    }
    const column = field(name);
    for (const [operator, expected] of Object.entries(value)) {
      if (operator === "_empty" || operator === "_nempty") {
        const empty = `(${column} IS NULL OR CAST(${column} AS TEXT) IN ('', '[]'))`;
        const negate = (operator === "_nempty") !== (expected === false || expected === "false");
        clauses.push(negate ? `NOT ${empty}` : empty);
      } else if (operator === "_eq" || operator === "_neq") {
        if (expected === null) clauses.push(`${column} IS ${operator === "_neq" ? "NOT " : ""}NULL`);
        else {
          clauses.push(`CAST(${column} AS TEXT) ${operator === "_eq" ? "=" : "!="} ?`);
          args.push(scalar(expected));
        }
      } else if (operator === "_in" || operator === "_nin") {
        const values = Array.isArray(expected) ? expected : String(expected).split(",");
        clauses.push(`${values.length ? `CAST(${column} AS TEXT) ${operator === "_nin" ? "NOT " : ""}IN (${values.map(() => "?").join(",")})` : "0"}`);
        args.push(...values.map(scalar));
      } else if (operator === "_icontains" || operator === "_contains") {
        clauses.push(operator === "_icontains" ? `instr(lower(CAST(${column} AS TEXT)), lower(?)) > 0` : `instr(CAST(${column} AS TEXT), ?) > 0`);
        args.push(String(expected));
      } else throw new Error(`Unsupported local filter: ${operator}`);
    }
  }
  return clauses.join(" AND ") || "1";
}

/** Local persistence for the existing asset repository contracts. No HTTP server. */
export class SqliteStore {
  constructor(filename) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
        PRIMARY KEY(collection, id)
      );
      CREATE INDEX IF NOT EXISTS records_project ON records(collection, json_extract(body, '$.project_id'));
      CREATE INDEX IF NOT EXISTS records_source ON records(collection, json_extract(body, '$.source'));
      CREATE INDEX IF NOT EXISTS records_source_hash ON records(collection, json_extract(body, '$.source_hash'));
      CREATE INDEX IF NOT EXISTS records_library ON records(collection, json_extract(body, '$.library_id'));
      PRAGMA user_version=1;`);
    this.listeners = new Set();
  }

  request(path, { method = "GET", body } = {}) {
    const url = new URL(path, "http://local.invalid");
    const match = url.pathname.match(/^\/items\/([a-z][a-z_0-9]*)(?:\/([^/]+))?$/);
    if (!match) throw new Error(`Unsupported local repository path: ${url.pathname}`);
    const collection = match[1];
    const id = match[2] ? decodeURIComponent(match[2]) : null;
    const params = url.searchParams;
    if (method === "GET") {
      const args = [collection];
      const filter = parseFilter(params);
      if (id) filter.id = { _eq: id };
      const predicate = `collection = ? AND (${where(filter, args)})`;
      const groups = [...params.getAll("groupBy[]"), ...(params.get("groupBy") || "").split(",").filter(Boolean)];
      const count = [...params.keys()].find((key) => key === "aggregate[count]" || key === "aggregate[countDistinct]");
      if (count) {
        const target = params.get(count);
        const columns = groups.map((name) => `${field(name)} AS "${name}"`);
        const aggregate = count.includes("countDistinct") ? `COUNT(DISTINCT ${field(target)})` : `COUNT(${target === "*" ? "*" : field(target)})`;
        const rows = this.db.prepare(`SELECT ${[...columns, `${aggregate} AS total`].join(",")} FROM records WHERE ${predicate}${groups.length ? ` GROUP BY ${groups.map(field).join(",")}` : ""}`).all(...args);
        return rows.map(({ total, ...group }) => ({ ...group, [count.includes("countDistinct") ? "countDistinct" : "count"]: target === "*" ? String(total) : { [target]: String(total) } }));
      }
      const orders = (params.get("sort") || "id").split(",").map((name) => `${field(name.replace(/^-/, ""))} ${name.startsWith("-") ? "DESC" : "ASC"}`);
      const limit = id ? 1 : Number(params.get("limit") ?? 100);
      const offset = Number(params.get("offset") || 0);
      if (!Number.isInteger(limit) || limit < -1 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid local pagination");
      const fields = params.get("fields")?.split(",");
      const projection = fields && !fields.includes("*") ? `json_object(${fields.map((key) => { const expression = field(key); return `'${key}', ${expression}`; }).join(",")}) AS body` : "body";
      const rows = this.db.prepare(`SELECT ${projection} FROM records WHERE ${predicate} ORDER BY ${orders.join(",")} LIMIT ? OFFSET ?`).all(...args, limit, offset).map((row) => JSON.parse(row.body));
      if (id && !rows.length) throw Object.assign(new Error("Record not found"), { statusCode: 404 });
      return id ? rows[0] : rows;
    }
    this.db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      if (method === "POST") {
        const items = Array.isArray(body) ? body : [body];
        result = items.map((item) => {
          if (!item || typeof item !== "object") throw new Error("Record must be an object");
          const now = new Date().toISOString();
          const record = { ...item, id: String(item.id || randomUUID()), date_created: item.date_created || now, date_updated: item.date_updated || now };
          this.db.prepare("INSERT INTO records VALUES (?, ?, ?)").run(collection, record.id, JSON.stringify(record));
          return record;
        });
        if (!Array.isArray(body)) result = result[0];
      } else if (method === "PATCH" && id) {
        const row = this.db.prepare("SELECT body FROM records WHERE collection=? AND id=?").get(collection, id);
        if (!row) throw Object.assign(new Error("Record not found"), { statusCode: 404 });
        result = { ...JSON.parse(row.body), ...body, id, date_updated: new Date().toISOString() };
        this.db.prepare("UPDATE records SET body=? WHERE collection=? AND id=?").run(JSON.stringify(result), collection, id);
      } else if (method === "DELETE") {
        const ids = id ? [id] : Array.isArray(body) ? body : body?.keys;
        if (!Array.isArray(ids)) throw new Error("Explicit record IDs required for deletion");
        for (const key of ids) this.db.prepare("DELETE FROM records WHERE collection=? AND id=?").run(collection, String(key));
        result = null;
      } else throw new Error(`Unsupported local operation: ${method}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.listeners) listener({ collection, method, id });
    return result;
  }

  import(collection, records) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body");
      for (const record of records) {
        if (!record?.id) throw new Error(`Missing migration id in ${collection}`);
        statement.run(collection, String(record.id), JSON.stringify(record));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async backup(path) { return backup(this.db, path); }
  integrity() { return this.db.prepare("PRAGMA integrity_check").all(); }
  close() { this.db.close(); }
}
