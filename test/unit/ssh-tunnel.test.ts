import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess extends EventEmitter {
  stderr = new EventEmitter();
  stdout = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.killed = true;
  });
}

let lastFakeChild: FakeChildProcess | undefined;
const spawnMock = vi.fn((..._args: unknown[]) => {
  lastFakeChild = new FakeChildProcess();
  return lastFakeChild;
});
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { findFreeLocalPort, openTunnel } = await import("../../src/ssh/tunnel.js");

const jumpTarget = { host: "bastion.example.com", user: "deploy", privateKey: "fake-key" };

afterEach(() => {
  spawnMock.mockClear();
  lastFakeChild = undefined;
});

// openTunnel does real fs I/O (mkdtemp/writeFile) before calling spawn(),
// which can take more than a single microtask/setImmediate tick — poll
// instead of guessing how many ticks are enough.
async function waitForSpawnCall(): Promise<void> {
  while (spawnMock.mock.calls.length === 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("findFreeLocalPort", () => {
  it("returns a port that is actually free to bind immediately afterwards", async () => {
    const port = await findFreeLocalPort();
    expect(port).toBeGreaterThan(0);

    // Prove it's genuinely free: bind to it for real right away.
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });

  it("can be called repeatedly without colliding", async () => {
    const ports = await Promise.all([findFreeLocalPort(), findFreeLocalPort(), findFreeLocalPort()]);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("openTunnel", () => {
  it("builds the expected ssh -N -L argv", async () => {
    const openPromise = openTunnel(jumpTarget, "127.0.0.1", 5432, { readyTimeoutMs: 500 });

    // Let spawn() happen, then simulate a successful tunnel by listening on
    // whatever local port ssh was told to forward to.
    await waitForSpawnCall();
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("ssh");
    expect(args).toContain("-N");
    expect(args).toContain("deploy@bastion.example.com");
    const forwardArg = args[args.indexOf("-L") + 1]!;
    const [localPortStr, remoteHost, remotePort] = forwardArg.split(":");
    expect(remoteHost).toBe("127.0.0.1");
    expect(remotePort).toBe("5432");

    const localPort = Number(localPortStr);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(localPort, "127.0.0.1", () => resolve()));

    try {
      const tunnel = await openPromise;
      expect(tunnel.localPort).toBe(localPort);
      await tunnel.close();
      expect(lastFakeChild?.kill).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("rejects with the ssh stderr when the tunnel process exits early (e.g. auth failure)", async () => {
    const openPromise = openTunnel(jumpTarget, "127.0.0.1", 5432, { readyTimeoutMs: 2000 });

    await waitForSpawnCall();
    lastFakeChild!.stderr.emit("data", Buffer.from("Permission denied (publickey).\n"));
    lastFakeChild!.emit("exit", 255);

    await expect(openPromise).rejects.toThrow(/Permission denied/);
  });

  it("times out if the tunnel never becomes ready and the process never exits", async () => {
    const openPromise = openTunnel(jumpTarget, "127.0.0.1", 5432, { readyTimeoutMs: 150 });
    await expect(openPromise).rejects.toThrow(/timed out/i);
  });
});
