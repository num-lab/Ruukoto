/** Fixed install slot; null means absent only — locked, denied and corrupt all throw. After write returns, persistence must be durable. */
export interface PersonalCredentialStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
