import { getTurbine } from '@nextera/shared';
import { freshness } from '../staleness.js';
import { businessKey, compactReading, defineTool } from './tool.js';

export const getTurbineTool = defineTool({
  name: 'get_turbine',
  title: 'Get a turbine',
  description:
    'One turbine by its id (e.g. "TURB002"): its farm, location, whether it is commissioned, ' +
    'its latest reading with the alert rules that reading triggered, and its reporting status ' +
    '(ok, stale-15, stale-30, stale-60 or no-data) with minutesSinceLatest.',
  inputSchema: {
    turbineId: businessKey('The turbine id, e.g. "TURB002".'),
  },
  async run({ db, now }, { turbineId }) {
    const turbine = await getTurbine(db, turbineId);
    return {
      id: turbine.id,
      farm: { id: turbine.farm.id, name: turbine.farm.name },
      latitude: turbine.latitude,
      longitude: turbine.longitude,
      commissioned: turbine.commissioned,
      ...freshness(turbine.latest?.timestamp ?? null, now()),
      latest: turbine.latest && compactReading(turbine.latest),
    };
  },
});
