import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { FleetStore, LiveStatus } from './fleet.store';

const LIVE_LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

/**
 * Parent of the fleet pages. Owns the FleetStore (provided here, so the overview and farm pages
 * share it): the fleet is loaded and the SSE connection opened once, and navigating between
 * pages neither reloads nor reconnects.
 */
@Component({
  selector: 'app-fleet-shell',
  imports: [RouterLink, RouterOutlet],
  providers: [FleetStore],
  template: `
    <header class="mb-6 flex items-center justify-between">
      <a routerLink="/" class="font-semibold text-muted no-underline hover:no-underline">
        Wind fleet
      </a>
      <span
        class="group inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1 text-sm"
        role="status"
        data-testid="live-status"
        [attr.data-status]="store.liveStatus()"
      >
        <span
          class="size-2 rounded-full bg-warn group-data-[status=offline]:bg-danger group-data-[status=open]:bg-ok"
          aria-hidden="true"
        ></span>
        {{ liveLabel() }}
      </span>
    </header>

    @if (store.error(); as error) {
      <p class="mb-4 rounded-lg bg-danger-bg px-4 py-3 text-danger" role="alert">{{ error }}</p>
    }

    @if (store.loading()) {
      <p class="text-muted">Loading fleet…</p>
    } @else {
      <router-outlet />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FleetShell implements OnInit {
  protected readonly store = inject(FleetStore);
  protected readonly liveLabel = computed(() => LIVE_LABELS[this.store.liveStatus()]);

  ngOnInit(): void {
    this.store.init();
  }
}
