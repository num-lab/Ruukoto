import type { DesktopBridge } from "../shared/bridge.ts";
declare global { interface Window { ruukoto: DesktopBridge } }
