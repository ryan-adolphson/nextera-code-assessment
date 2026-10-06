import { parseCsv } from './seed-from-csv.js';

describe('parseCsv', () => {
  const columns = ['farm_id', 'farm_name', 'latitude', 'longitude'];

  it('maps rows to objects by header (tolerates CRLF and a trailing newline)', () => {
    const text =
      'farm_id,farm_name,latitude,longitude\r\nFARM01,Prairie Ridge,41.25,-96.53\r\n';

    expect(parseCsv(text, columns)).toEqual([
      {
        farm_id: 'FARM01',
        farm_name: 'Prairie Ridge',
        latitude: '41.25',
        longitude: '-96.53',
      },
    ]);
  });

  it('rejects an unexpected header', () => {
    expect(() => parseCsv('id,name\nFARM01,x', columns)).toThrow(
      /Unexpected CSV header/,
    );
  });

  it('rejects a row with the wrong number of values, naming the line', () => {
    const text =
      'farm_id,farm_name,latitude,longitude\nFARM01,Prairie Ridge,41.25';
    expect(() => parseCsv(text, columns)).toThrow(/line 2/);
  });
});
