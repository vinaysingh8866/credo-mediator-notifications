import type { AgentContext } from "@credo-ts/core";
import type { BaseRecord, TagsBase } from "@credo-ts/core";
import { Database } from "sqlite3";
import type {
  StorageService,
  BaseRecordConstructor,
  Query,
} from "@credo-ts/core";
export type QueryOptions = {
  limit?: number;
  offset?: number;
};
import { SQLWallet } from "./SQLWallet";

import {
  RecordNotFoundError,
  RecordDuplicateError,
  JsonTransformer,
  injectable,
} from "@credo-ts/core";

interface StorageRecord {
  value: Record<string, unknown>;
  tags: Record<string, unknown>;
  type: string;
  id: string;
}

@injectable()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class SQLiteStorageService<
  T extends BaseRecord<any, any, any> = BaseRecord<any, any, any>
> implements StorageService<T>
{
  public db: Database = new Database("db.sqlite");

  constructor() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        tags TEXT NOT NULL
      )
    `);
  }

  private recordToInstance(
    record: StorageRecord,
    recordClass: BaseRecordConstructor<T>
  ): T {
    const instance = JsonTransformer.fromJSON<T>(record.value, recordClass);
    instance.id = record.id;
    instance.replaceTags(record.tags as TagsBase);

    return instance;
  }

  /** @inheritDoc */
  public async save(agentContext: AgentContext, record: T) {
    console.log(record);
    record.updatedAt = new Date();
    let t: Partial<any>;
    try {
      try {
        t = record.getTags();
        console.log(t);
        record.setTags({
          ...t,
          created_at: record.createdAt.toISOString(),
          updated_at: record.updatedAt.toISOString(),
        });
      } catch (e) {
        console.log(e);

        record.setTags({
          created_at: record.createdAt.toISOString(),
          updated_at: record.updatedAt.toISOString(),
        });
      }
    } catch (e) {
      record.setTags({
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const value = JsonTransformer.toJSON(record);
    console.log(value);
    return new Promise<void>((resolve, reject) => {
      this.db.run(
        `INSERT INTO records (id, type, value, tags) VALUES (?, ?, ?, ?)`,
        [
          record.id,
          record.type,
          JSON.stringify(value),
          JSON.stringify(t || {}),
        ],
        (err: any) => {
          if (err) {
            if (err.code === "SQLITE_CONSTRAINT") {
              reject(
                new RecordDuplicateError(
                  `Record with id ${record.id} already exists`,
                  { recordType: record.type }
                )
              );
            } else {
              reject(err);
            }
          } else {
            resolve();
          }
        }
      );
    });
  }

  /** @inheritDoc */
  public async update(agentContext: AgentContext, record: T): Promise<void> {
    record.updatedAt = new Date();
    const value = JsonTransformer.toJSON(record);
    delete value._tags;

    return new Promise<void>((resolve, reject) => {
      const tags = JSON.stringify(record.getTags());
      this.db.run(
        `UPDATE records SET value = ?, tags = ? WHERE id = ?`,
        [JSON.stringify(value), tags, record.id],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  /** @inheritDoc */
  public async delete(agentContext: AgentContext, record: T) {
    return new Promise<void>((resolve, reject) => {
      this.db.run(`DELETE FROM records WHERE id = ?`, [record.id], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** @inheritDoc */
  public async deleteById(
    agentContext: AgentContext,
    recordClass: BaseRecordConstructor<T>,
    id: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.run(`DELETE FROM records WHERE id = ?`, [id], (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** @inheritDoc */
  public async getById(
    agentContext: AgentContext,
    recordClass: BaseRecordConstructor<T>,
    id: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.db.get(
        `SELECT * FROM records WHERE id = ?`,
        [id],
        (err, row: any) => {
          if (err) {
            reject(err);
          } else if (row) {
            resolve(
              this.recordToInstance(
                {
                  value: JSON.parse(row.value),
                  tags: JSON.parse(row.tags),
                  id: row.id,
                  type: row.type,
                },
                recordClass
              )
            );
          } else {
            reject(
              new RecordNotFoundError(`record with id ${id} not found.`, {
                recordType: recordClass.type,
              })
            );
          }
        }
      );
    });
  }

  /** @inheritDoc */
  public async getAll(
    agentContext: AgentContext,
    recordClass: BaseRecordConstructor<T>
  ): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      this.db.all(
        `SELECT * FROM records WHERE type = ?`,
        [recordClass.type],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const instances = rows.map((row: any) =>
              this.recordToInstance(
                {
                  value: JSON.parse(row.value),
                  tags: JSON.parse(row.tags),
                  id: row.id,
                  type: row.type,
                },
                recordClass
              )
            );
            resolve(instances);
          }
        }
      );
    });
  }

  /** @inheritDoc */
  public async findByQuery(
    agentContext: AgentContext,
    recordClass: BaseRecordConstructor<T>,
    query: Query<T>,
    queryOptions?: QueryOptions
  ): Promise<T[]> {
    const { offset = 0, limit } = queryOptions || {};

    return new Promise<T[]>((resolve, reject) => {
      this.db.all(
        `SELECT * FROM records WHERE type = ?`,
        [recordClass.type],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const allRecords = rows.map((row: any) => ({
              value: JSON.parse(row.value),
              tags: JSON.parse(row.tags),
              id: row.id,
              type: row.type,
            }));

            const filteredRecords = allRecords.filter((record) =>
              filterByQuery(record, query)
            );
            const slicedRecords =
              limit !== undefined
                ? filteredRecords.slice(offset, offset + limit)
                : filteredRecords.slice(offset);
            const instances = slicedRecords.map((record) =>
              this.recordToInstance(record, recordClass)
            );

            resolve(instances);
          }
        }
      );
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filterByQuery<T extends BaseRecord<any, any, any>>(
  record: StorageRecord,
  query: Query<T>
) {
  const { $and, $or, $not, ...restQuery } = query;

  if ($not) {
    throw new Error("$not query not supported in SQLite storage");
  }

  if (!matchSimpleQuery(record, restQuery)) return false;

  if ($and) {
    const allAndMatch = ($and as Query<T>[]).every((and) =>
      filterByQuery(record, and)
    );

    if (!allAndMatch) return false;
  }

  if ($or) {
    const oneOrMatch = ($or as Query<T>[]).some((or) =>
      filterByQuery(record, or)
    );
    if (!oneOrMatch) return false;
  }

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchSimpleQuery<T extends BaseRecord<any, any, any>>(
  record: StorageRecord,
  query: Query<T>
) {
  const tags = record.tags as TagsBase;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      const tagValue = tags[key];
      if (
        !Array.isArray(tagValue) ||
        !value.every((v) => tagValue.includes(v))
      ) {
        return false;
      }
    } else if (tags[key] !== value) {
      return false;
    }
  }

  return true;
}
