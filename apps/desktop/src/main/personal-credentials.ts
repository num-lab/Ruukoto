/** 固定安装槽；null 只表示不存在，锁定、拒绝和损坏均抛错。write 完成须已安全持久化。 */
export interface PersonalCredentialStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
