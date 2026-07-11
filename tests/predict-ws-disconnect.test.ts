import { describe, expect, it } from 'vitest';
import { PredictWsClient } from '../src/venues/predict-ws.js';

/** 验证 WS 层"断线全撤"管道新增：onDisconnect 必须触发已注册的 disconnectListener。
 *  这是修复"主循环卡死 + WS 断线"裸奔窗口的 WS 端核心——回调独立于主循环。 */
describe('PredictWsClient disconnect listener', () => {
  it('fires the registered disconnectListener when onDisconnect runs', () => {
    const client = new PredictWsClient('ws://localhost:9', undefined);
    let fired = 0;
    client.setDisconnectListener(() => {
      fired += 1;
    });
    // onDisconnect is private at compile time but is exactly what the socket 'close'/'error' handlers invoke.
    (client as unknown as { onDisconnect(): void }).onDisconnect();
    expect(fired).toBe(1);
  });

  it('does not throw when no disconnectListener is registered', () => {
    const client = new PredictWsClient('ws://localhost:9', undefined);
    expect(() => (client as unknown as { onDisconnect(): void }).onDisconnect()).not.toThrow();
  });
});
