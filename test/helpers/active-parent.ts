import type { Responder } from "./mock-provider.ts";
import { lastUserText } from "./testkit.ts";

/** 公共委派测试保留父 prompt 与目录占用，释放后仍由真实 Driver 收尾。 */
export function holdParentResponse(respond: Responder) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const responder: Responder = async (req, index) => {
    if (lastUserText(req).startsWith("开始")) await gate;
    return respond(req, index);
  };
  return { responder, release };
}
