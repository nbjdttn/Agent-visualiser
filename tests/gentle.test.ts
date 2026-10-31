import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestState, newControlInfo, nonce, openControl, parseRelayLines, sealControl, type StateMessage } from '../core/sync/control';
import {
  AGENT_ENV,
  OPT_OUT_ENV,
  agentJobs,
  decidePresence,
  Holder,
  jobNames,
  coresBusy,
  parseCpuTime,
  parseGpuUtil,
  parsePressure,
  parseSwap,
  parseVmStat,
  parseRemoteSession,
  isGenuineInput,
  parseIdleSeconds,
  parseInputSource,
  RealInput,
  parseNames,
  parsePs,
  recover,
  shareFraction,
  type Exec,
  type Held,
} from '../scripts/gentle-lib';

const IOREG = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 22>
    {
      "IOClass" = "IOHIDSystem"
      "HIDIdleTime" = 5123456789
      "HIDParameters" = {"HIDClickTime"=500000000}
    }
`;

const PMSET = `2026-10-31 16:30:00 +0000
Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleDisplaySleep    1
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 412(coreaudiod): [0x00001a3b000193d1] 00:05:23 PreventUserIdleSystemSleep named: "com.apple.audio.context"
   pid 1234(Google Chrome): [0x0000c4d900018a7f] 00:02:10 PreventUserIdleDisplaySleep named: "Video Wake Lock"
   pid 5678(caffeinate): [0x0000c4d900018a80] 01:00:00 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
   pid 4469(remoting_me2me_host): [0x00080b6400058248] 00:01:25 NoDisplaySleepAssertion named: "Remoting session is active"
   pid 344(WindowServer): [0x0000a2eb0001867e] 00:00:00 UserIsActive named: "com.apple.iohideventsystem.queue.tickle"
`;

describe('reading the Mac', () => {
  it('reads keyboard and mouse idle time from ioreg', () => {
    expect(parseIdleSeconds(IOREG)).toBeCloseTo(5.123456789, 6);
    expect(parseIdleSeconds('nothing here')).toBeUndefined();
  });

  it('tells a person\'s input from events a program posts', () => {
    const tickle = (src: string) => `   pid 424(WindowServer): [0x0006903400098071] 00:00:50 UserIsActive named: "com.apple.iohideventsystem.queue.tickle.nxevent ${src}"`;
    const amph = 'service:IOHIDSystem pid:3757 process:Amphetamine';
    expect(parseInputSource(tickle(amph))).toBe(amph);
    expect(parseInputSource(PMSET)).toBeUndefined();
    expect(isGenuineInput('serviceID:100046089 service:AppleMultitouchDevice product:Magic Mouse eventType:6')).toBe(true);
    expect(isGenuineInput('serviceID:10001e7a6 service:AppleHIDKeyboardEventDriverV2 product:Magic Keyboard eventType:3')).toBe(true);
    expect(isGenuineInput('serviceID:0 service:(null) product:(null) eventType:29')).toBe(true); // Touch ID
    expect(isGenuineInput('service:IOHIDSystem pid:4469 process:remoting_me2me_host')).toBe(true); // you, from another computer
    expect(isGenuineInput(amph)).toBe(false);
    expect(isGenuineInput('service:IOHIDSystem pid:99 process:MouseJiggler')).toBe(false);
    expect(isGenuineInput(undefined)).toBe(true);
  });

  it('keeps the time of your last real input across a keep-awake tool moving the mouse', () => {
    const amph = 'service:IOHIDSystem pid:3757 process:Amphetamine';
    const mouse = 'service:AppleMultitouchDevice product:Magic Mouse eventType:17';
    const input = new RealInput();
    expect(input.update(1_000_000, 5, mouse)).toBe(5);
    expect(input.isNew(1_060_000, 1)).toBe(true);
    expect(input.update(1_060_000, 1, amph)).toBe(65); // Amphetamine moved the mouse: you're still 65 s idle
    expect(input.isNew(1_062_000, 3)).toBe(false);
    expect(input.update(1_062_000, 3)).toBe(67);
    expect(input.update(1_070_000, 0.5, 'service:IOHIDSystem pid:4469 process:remoting_me2me_host')).toBe(0.5);
    expect(input.update(1_071_000, undefined)).toBeUndefined();
    expect(new RealInput().update(1_000_000, 2, amph)).toBe(Infinity); // only a program's input seen so far
  });

  it('sees a connected remote-desktop session, not a video, call or keep-awake tool', () => {
    expect(parseRemoteSession(PMSET)).toBe(true);
    expect(parseRemoteSession(PMSET.replace(/.*remoting_me2me_host.*\n/, ''))).toBe(false);
  });

  it('reads GPU use, memory, memory pressure and swap', () => {
    expect(parseGpuUtil('"PerformanceStatistics" = {"Tiler Utilization %"=10,"Device Utilization %"=37,"Renderer Utilization %"=35}')).toBe(37);
    expect(parseGpuUtil('"Device Utilization %"=5\n"Device Utilization %"=62')).toBe(62);
    expect(parseGpuUtil('no gpu here')).toBeUndefined();
    const vm = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               12345.',
      'Pages active:                            400000.',
      'Pages wired down:                        150000.',
      'Pages purgeable:                          20000.',
      'Anonymous pages:                         500000.',
      'Pages occupied by compressor:             80000.',
    ].join('\n');
    expect(parseVmStat(vm)).toBe((500000 - 20000 + 150000 + 80000) * 16384);
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 100.\nPages wired down: 50.\n')).toBe(150 * 4096);
    expect(parseVmStat('nothing')).toBeUndefined();
    expect(parsePressure('1\n')).toBe('normal');
    expect(parsePressure('2')).toBe('warn');
    expect(parsePressure('4')).toBe('critical');
    expect(parseSwap('total = 2048.00M  used = 1234.56M  free = 813.44M  (encrypted)')).toBeCloseTo(1234.56 * 1024 ** 2);
    expect(parseSwap('total = 0.00M  used = 0.00M  free = 0.00M')).toBe(0);
  });

  it('works out how many cores the whole Mac is using', () => {
    const before = [
      { idle: 100, total: 200 },
      { idle: 50, total: 100 },
    ];
    const after = [
      { idle: 150, total: 300 },
      { idle: 50, total: 200 },
    ];
    expect(coresBusy(before, after)).toBeCloseTo(1.5);
    expect(coresBusy([], after)).toBeUndefined();
  });

  it('reads CPU time in the formats ps uses', () => {
    expect(parseCpuTime('0:01.50')).toBeCloseTo(1.5);
    expect(parseCpuTime('321:45.00')).toBeCloseTo(321 * 60 + 45);
    expect(parseCpuTime('01:02:03')).toBe(3723);
    expect(parseCpuTime('2-01:02:03')).toBe(2 * 86_400 + 3723);
  });

  it('works out how much of the time agent jobs may run to leave cores free', () => {
    expect(shareFraction(5, 8)).toBe(1); // using less than allowed: nothing to do
    expect(shareFraction(10, 8)).toBeCloseTo(0.8); // 10 cores wanted, 8 allowed
    expect(shareFraction(16, 8)).toBeCloseTo(0.5);
    expect(shareFraction(100, 1)).toBe(0.1); // never stopped for more than 90% of the time
    expect(shareFraction(0, 8)).toBe(1);
  });

  it('decides whether someone is at the Mac', () => {
    const base = { mode: 'auto' as const, awayAfterSec: 120 };
    expect(decidePresence({ ...base, idleSec: 3 })).toEqual({ here: true, reason: 'input' });
    expect(decidePresence({ ...base, idleSec: 600 })).toEqual({ here: false, reason: 'away' });
    expect(decidePresence({ ...base, idleSec: 300, remote: true })).toEqual({ here: true, reason: 'remote' });
    expect(decidePresence({ ...base, idleSec: 610, remote: true })).toEqual({ here: false, reason: 'away' });
    expect(decidePresence({ ...base, idleSec: 3 * 3600, remote: true })).toEqual({ here: false, reason: 'away' });
    expect(decidePresence({ ...base, idleSec: undefined })).toEqual({ here: false, reason: 'unknown' });
    expect(decidePresence({ ...base, idleSec: 9999, mode: 'work' })).toEqual({ here: true, reason: 'work' });
    expect(decidePresence({ ...base, idleSec: 1, mode: 'full' })).toEqual({ here: false, reason: 'full' });
  });
});

describe("finding the agents' jobs", () => {
  const UID = 501;
  const ps = [
    [1, 0, 0, 0, '/sbin/launchd'],
    [500, 1, UID, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
    [501, 500, UID, 0, '-zsh'],
    [510, 501, UID, 4, 'claude'],
    [520, 510, UID, 0, '/bin/zsh -c python3 sim.py --steps 1e9'],
    [530, 520, UID, 180, '/opt/homebrew/bin/python3 sim.py --steps 1e9'],
    [531, 530, UID, 90, '/opt/homebrew/bin/python3 -c worker'],
    [521, 510, UID, 2, 'node /tmp/light.js'],
    [600, 501, UID, 3, 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    [610, 600, UID, 95, '/Applications/Julia-1.11.app/Contents/Resources/julia/bin/julia run.jl'],
    [700, 1, UID, 150, '/opt/homebrew/bin/python3 -m jupyter lab'],
    [800, 1, UID, 120, '/opt/homebrew/bin/python3 long_sim.py'],
    [900, 1, UID, 5, '/Applications/Claude.app/Contents/MacOS/Claude'],
    [910, 900, UID, 40, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer'],
    [950, 501, UID, 1, '/opt/homebrew/bin/codex'],
    [960, 950, UID, 300, 'cargo build --release'],
    [970, 510, 0, 100, '/usr/bin/some-root-helper'],
    [980, 510, UID, 60, 'node /Users/me/Agent-visualiser/node_modules/tsx/dist/cli.mjs /Users/me/Agent-visualiser/scripts/gentle.ts run'],
  ] as const;
  const psOut = ps.map(([pid, ppid, uid, cpu, cmd]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(uid).padStart(5)} ${cpu.toFixed(1).padStart(5)} ${cmd}`).join('\n');
  const names = new Map<number, string>([
    [510, 'claude'],
    [530, 'python3.12'],
    [531, 'python3.12'],
    [600, 'node'],
    [610, 'julia'],
    [700, 'python3.12'],
    [800, 'python3.12'],
    [900, 'Claude'],
    [910, 'Claude Helper (R'],
    [950, 'codex'],
    [960, 'cargo'],
    [980, 'node'],
  ]);

  it('parses ps output, including names with spaces', () => {
    const procs = parsePs(psOut);
    expect(procs).toHaveLength(ps.length);
    expect(procs.find((p) => p.pid === 530)).toEqual({ pid: 530, ppid: 520, uid: UID, cpu: 180, command: '/opt/homebrew/bin/python3 sim.py --steps 1e9' });
    expect(parseNames('  910 Claude Helper (R\n  510 claude\n').get(910)).toBe('Claude Helper (R');
  });

  it("returns busy jobs below Claude Code or Codex and jobs an agent's environment marks, nothing else", () => {
    const jobs = agentJobs(parsePs(psOut), names, new Set([800]), { uid: UID, self: 4242, minCpu: 25 });
    expect(jobs.map((j) => j.pid).sort((a, b) => a - b)).toEqual([530, 531, 610, 800, 960]);
  });
});

describe('environment markers', () => {
  it('tells marked jobs from opted-out ones', () => {
    expect(AGENT_ENV.test('PATH=/bin CLAUDECODE=1 HOME=/Users/x')).toBe(true);
    expect(AGENT_ENV.test('PATH=/bin AV_GENTLE=1')).toBe(true);
    expect(OPT_OUT_ENV.test('CLAUDECODE=1 AV_GENTLE=0 OMP_NUM_THREADS=1')).toBe(true);
    expect(OPT_OUT_ENV.test('AV_GENTLE=1')).toBe(false);
    expect(OPT_OUT_ENV.test('XAV_GENTLE=0')).toBe(false);
  });
});

describe('holding jobs back', () => {
  let holder: Holder | undefined;
  afterEach(async () => {
    await holder?.releaseAll();
  });

  function fakeExec(opts: { taskpolicy?: boolean; dead?: number[] } = {}) {
    const calls: string[] = [];
    const exec: Exec = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(' '));
        return { ok: opts.taskpolicy !== false, out: '' };
      },
      signal(pid, sig) {
        calls.push(`kill -${sig.slice(3)} ${pid}`);
        return true;
      },
      alive: (pid) => !(opts.dead ?? []).includes(pid),
    };
    return { exec, calls };
  }
  const job = (pid: number) => ({ pid, ppid: 1, uid: 501, cpu: 100, command: `python3 job${pid}.py` });

  it('slows with background priority and restores it', async () => {
    const { exec, calls } = fakeExec();
    holder = new Holder(exec);
    expect(await holder.hold(job(10), 'python3', 'slow')).toBe(true);
    expect(await holder.hold(job(10), 'python3', 'slow')).toBe(false);
    expect(holder.held.get(10)?.how).toBe('slow');
    expect(await holder.releaseAll()).toBe(1);
    expect(calls).toEqual(['taskpolicy -b -p 10', 'taskpolicy -B -p 10']);
  });

  it('shares: runs jobs part of every 50 ms, only when they need holding back', async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = fakeExec();
      holder = new Holder(exec);
      await holder.hold(job(30), 'python3', 'share');
      await holder.hold(job(31), 'julia', 'share');
      expect(holder.held.get(30)?.how).toBe('share');
      vi.advanceTimersByTime(500);
      expect(calls).toEqual([]); // share is 100% until told otherwise
      holder.setShare(0.8);
      vi.advanceTimersByTime(40); // 40 ms running...
      expect(calls).toEqual(['kill -STOP 30', 'kill -STOP 31']);
      vi.advanceTimersByTime(10); // ...10 ms stopped
      expect(calls.slice(2)).toEqual(['kill -CONT 30', 'kill -CONT 31']);
      vi.advanceTimersByTime(1000);
      expect(calls.filter((c) => c.includes('STOP')).length).toBe(2 * 21);
      holder.setShare(1); // they no longer need holding back: everything runs
      const n = calls.length;
      vi.advanceTimersByTime(1000);
      expect(calls.length - n).toBeLessThanOrEqual(2);
      expect(calls.at(-1)).toMatch(/CONT/);
      await holder.release(30);
      expect(calls.at(-1)).toBe('kill -CONT 30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares instead when background priority is refused or known not to work', async () => {
    const refused = fakeExec({ taskpolicy: false });
    holder = new Holder(refused.exec);
    await holder.hold(job(11), 'julia', 'slow');
    expect(holder.held.get(11)?.how).toBe('share');
    expect(refused.calls).toEqual(['taskpolicy -b -p 11']);
    await holder.releaseAll();

    const unknown = fakeExec();
    holder = new Holder(unknown.exec, () => undefined, Date.now, false);
    await holder.hold(job(14), 'julia', 'slow');
    expect(holder.held.get(14)?.how).toBe('share');
    await holder.release(14);
    expect(unknown.calls).toEqual(['kill -CONT 14']);
  });

  it('pauses and resumes', async () => {
    const { exec, calls } = fakeExec();
    holder = new Holder(exec);
    await holder.hold(job(12), 'cargo', 'pause');
    await holder.releaseAll();
    expect(calls).toEqual(['kill -STOP 12', 'kill -CONT 12']);
  });

  it('forgets finished jobs without touching them', async () => {
    const { exec, calls } = fakeExec({ dead: [13] });
    holder = new Holder(exec);
    await holder.hold(job(13), 'python3', 'slow');
    holder.prune(new Set([1, 2, 3]));
    expect(holder.held.size).toBe(0);
    expect(calls).toEqual(['taskpolicy -b -p 13']);
  });

  it("lets go of a previous run's jobs, but only the same processes", async () => {
    const { exec, calls } = fakeExec({ dead: [22] });
    const prev: Held[] = [
      { pid: 20, name: 'a', command: 'python3 a.py', how: 'slow', since: 0 },
      { pid: 21, name: 'b', command: 'python3 b.py', how: 'pause', since: 0 },
      { pid: 22, name: 'c', command: 'python3 c.py', how: 'pause', since: 0 },
      { pid: 23, name: 'd', command: 'python3 d.py', how: 'cap', since: 0 },
    ];
    const now = new Map([
      [20, 'python3 a.py'],
      [21, 'python3 b.py'],
      [23, 'something else now'],
    ]);
    expect(await recover(prev, exec, (pid) => now.get(pid))).toBe(2);
    expect(calls).toEqual(['taskpolicy -B -p 20', 'kill -CONT 21']);
  });

  it('names jobs briefly', () => {
    const h = (name: string, pid: number): Held => ({ pid, name, command: name, how: 'slow', since: 0 });
    expect(jobNames([h('python3', 1)])).toBe('python3');
    expect(jobNames([h('python3', 1), h('julia', 2)])).toBe('python3 and julia');
    expect(jobNames([h('python3', 1), h('python3', 2), h('julia', 3), h('cargo', 4)])).toBe('python3, julia and cargo');
    expect(jobNames([h('a', 1), h('b', 2), h('c', 3), h('d', 4)])).toBe('a, b and 2 more');
  });
});

describe('the phone link', () => {
  it('seals and opens messages, bound to the key and topic', async () => {
    const info = newControlInfo();
    expect(info.relay).toBe('https://ntfy.sh');
    expect(info.topic).toMatch(/^av-[\w-]{20}$/);
    const ping = { t: 'ping' as const, at: 1_700_000_000_000, n: nonce() };
    expect(await openControl(info, await sealControl(info, ping))).toEqual(ping);
    const msg = { t: 'set' as const, mode: 'work' as const, at: 1_700_000_000_000, by: 'abc', n: nonce() };
    const sealed = await sealControl(info, msg);
    expect(sealed.startsWith('av1.')).toBe(true);
    expect(sealed).not.toContain('work');
    expect(await openControl(info, sealed)).toEqual(msg);
    expect(await openControl({ ...info, topic: 'av-someone-elses-topic' }, sealed)).toBeNull();
    expect(await openControl(newControlInfo(), sealed)).toBeNull();
    const tampered = sealed.slice(0, -3) + (sealed.endsWith('A') ? 'BBB' : 'AAA');
    expect(await openControl(info, tampered)).toBeNull();
    expect(await openControl(info, 'hello')).toBeNull();
  });

  it("finds the Mac's newest state in a relay poll", async () => {
    const info = newControlInfo();
    const state = (at: number, held: number): StateMessage => ({ t: 'state', mode: 'auto', here: true, reason: 'input', held, how: 'slow', at, n: nonce() });
    const lines = [
      JSON.stringify({ id: 'a', time: 1, event: 'open' }),
      JSON.stringify({ id: 'b', time: 2, event: 'message', message: await sealControl(info, state(2000, 1)) }),
      JSON.stringify({ id: 'c', time: 3, event: 'message', message: await sealControl(info, state(3000, 2)) }),
      JSON.stringify({ id: 'd', time: 4, event: 'message', message: await sealControl(info, { t: 'set', mode: 'full', at: 4000, n: nonce() }) }),
      JSON.stringify({ id: 'e', time: 5, event: 'message', message: 'not ours' }),
      'garbage',
    ].join('\n');
    const events = parseRelayLines(lines);
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect((await latestState(info, events))?.held).toBe(2);
  });
});
