import { TestBed } from '@angular/core/testing';
import {
  BROWSER_TIME_ZONE,
  TIME_ZONE_STORAGE_PREFIX,
  TimeZoneSettings,
  UTC_ZONE,
  formatIn,
  offsetLabel,
  validZone,
  zoneAbbr,
  zoneContext,
  zoneOffsetMs,
} from './time-zone';

const WINTER = Date.parse('2026-01-02T18:00:00Z');
const SUMMER = Date.parse('2026-07-02T18:00:00Z');
const key = (email: string) => `${TIME_ZONE_STORAGE_PREFIX}${email}`;

describe('TimeZoneSettings', () => {
  const settings = (browserZone = 'America/Chicago') => {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_TIME_ZONE, useValue: browserZone }],
    });
    return TestBed.inject(TimeZoneSettings);
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('shows UTC by default, signed out or for a user who never chose', () => {
    const s = settings();
    expect(s.mode()).toBe('utc');
    expect(s.zone()).toBe(UTC_ZONE);
    expect(s.label()).toBe('UTC');
    expect(s.tag()).toBe('UTC');
    expect(s.ctx()).toBe(zoneContext(UTC_ZONE));
    s.useAccount('viewer@nextera.local');
    expect(s.mode()).toBe('utc');
  });

  it("switches to the browser's zone and saves the choice for the signed-in user", () => {
    const s = settings();
    s.useAccount('Viewer@Nextera.local ');
    s.setMode('local');
    expect(s.mode()).toBe('local');
    expect(s.zone()).toBe('America/Chicago');
    expect(s.label()).toBe('local time (America/Chicago)');
    expect(s.tag()).toBe('local');
    expect(s.offsetLabel(WINTER)).toBe('UTC−6');
    expect(s.offsetLabel(SUMMER)).toBe('UTC−5');
    expect(localStorage.getItem(key('viewer@nextera.local'))).toBe('local');

    s.setMode('utc');
    expect(s.zone()).toBe(UTC_ZONE);
    expect(s.offsetLabel(WINTER)).toBe('UTC');
    expect(localStorage.getItem(key('viewer@nextera.local'))).toBe('utc');
  });

  it("reads each user's own setting (another user on this browser keeps theirs)", () => {
    localStorage.setItem(key('owner@nextera.local'), 'local');
    const s = settings('Asia/Kolkata');
    s.useAccount('owner@nextera.local');
    expect(s.zone()).toBe('Asia/Kolkata');
    s.useAccount('admin@nextera.local');
    expect(s.zone()).toBe(UTC_ZONE);
    s.useAccount(null);
    expect(s.zone()).toBe(UTC_ZONE);
    s.setMode('local'); // nobody signed in: in memory only
    expect(s.mode()).toBe('local');
    expect(localStorage.length).toBe(1);
  });

  it('treats an unknown stored value as UTC', () => {
    localStorage.setItem(key('admin@nextera.local'), 'Europe/Paris');
    const s = settings();
    s.useAccount('admin@nextera.local');
    expect(s.mode()).toBe('utc');
  });

  it('keeps working when localStorage throws (the choice lives in memory)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const s = settings();
    s.useAccount('admin@nextera.local');
    expect(s.mode()).toBe('utc');
    expect(() => s.setMode('local')).not.toThrow();
    expect(s.zone()).toBe('America/Chicago');
  });

  it("reads the browser's zone from Intl by default", () => {
    const zone = TestBed.inject(BROWSER_TIME_ZONE);
    expect(zone).toBe(validZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
  });
});

describe('zone helpers', () => {
  it('accepts IANA zones Intl knows, else UTC', () => {
    expect(validZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(validZone('Mars/Olympus_Mons')).toBe(UTC_ZONE);
    expect(validZone(undefined)).toBe(UTC_ZONE);
  });

  it('gives offsets, short names and offset labels per instant (DST-aware)', () => {
    expect(zoneOffsetMs('America/Chicago', WINTER)).toBe(-6 * 3_600_000);
    expect(zoneOffsetMs('America/Chicago', SUMMER)).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(UTC_ZONE, WINTER)).toBe(0);
    expect(zoneAbbr('America/Chicago', WINTER)).toBe('CST');
    expect(zoneAbbr('America/Chicago', SUMMER)).toBe('CDT');
    expect(zoneAbbr(UTC_ZONE, WINTER)).toBe('UTC');
    expect(offsetLabel('Asia/Kolkata', WINTER)).toBe('UTC+5:30');
    expect(offsetLabel('Asia/Kathmandu', WINTER)).toBe('UTC+5:45');
    expect(offsetLabel('Europe/Paris', SUMMER)).toBe('UTC+2');
    expect(offsetLabel(UTC_ZONE, WINTER)).toBe('UTC');
  });

  it('formats in a zone, with its short name on request', () => {
    expect(formatIn(WINTER, 'MMM d, HH:mm', UTC_ZONE, true)).toBe('Jan 2, 18:00 UTC');
    expect(formatIn(WINTER, 'MMM d, HH:mm', 'America/Chicago', true)).toBe('Jan 2, 12:00 CST');
    expect(formatIn(WINTER, 'MMM d, HH:mm', 'Asia/Kolkata')).toBe('Jan 2, 23:30');
    expect(zoneContext('Asia/Kolkata')).toBe(zoneContext('Asia/Kolkata')); // cached
  });
});
