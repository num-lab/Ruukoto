/** 控制面可见的错误（code 原样进入应答）；Runtime 与拥有者 IM 入口的配置校验共用。 */
export class RuntimeApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
