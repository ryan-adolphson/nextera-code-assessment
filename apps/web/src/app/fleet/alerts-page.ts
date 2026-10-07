import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AlertingTabs } from '../alerting/alerting-tabs';
import { paginate } from '../ui/paging';
import { StatTile } from '../ui/stat-tile';
import { TABLE_IMPORTS } from '../ui/table';
import { ALERT_LABELS, ALERT_LEVELS, alertCounts, formatAge } from './alerts';
import { FleetStore, FleetTurbine } from './fleet.store';
import { StalenessBadge } from './staleness-badge';

/**
 * /alerting (the "Active" tab; "Rules" is /alerting/rules): the turbines needing attention now, by the existing staleness rules only. Counts per
 * level, then one list worst first (60 → 30 → 15 min → never reported), each linking to its
 * turbine page. Moves with the store's minute clock and live readings.
 */
@Component({
  selector: 'app-alerts-page',
  imports: [AlertingTabs, DatePipe, RouterLink, StalenessBadge, StatTile, TABLE_IMPORTS],
  templateUrl: './alerts-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsPage {
  protected readonly store = inject(FleetStore);
  protected readonly levels = ALERT_LEVELS;
  protected readonly labels = ALERT_LABELS;
  protected readonly counts = computed(() => alertCounts(this.store.turbines()));
  protected readonly columns = ['turbine', 'farm', 'status', 'last', 'age'];
  /** The list, 25 per page (Material paginator); stays on its page as alerts come and go. */
  protected readonly paging = paginate(this.store.alerts, 25);
  protected readonly trackById = (_: number, t: FleetTurbine) => t.id;

  /** How long ago the turbine's latest reading was measured, on the client clock. */
  protected age(timestamp: string): string {
    return formatAge(this.store.now() - Date.parse(timestamp));
  }
}
