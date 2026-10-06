import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AlertRulesStore } from '../alerting/alert-rules.store';
import { FleetStore, LiveStatus } from './fleet.store';

const LIVE_LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

/** The main navigation, in order. `id` picks the icon and the `nav-<id>` test hook. */
export const NAV_ITEMS = [
  { id: 'farms', path: '/farms', label: 'Farms' },
  { id: 'turbines', path: '/turbines', label: 'Turbines' },
  { id: 'alerting', path: '/alerting', label: 'Alerting' },
  { id: 'reporting', path: '/reporting', label: 'Reporting' },
] as const;

/**
 * Parent of every page: the side navigation and the page region. Owns the FleetStore and the
 * AlertRulesStore (provided here, so all pages share them): the fleet is loaded and the SSE connection opened once, and
 * navigating between pages neither reloads nor reconnects.
 *
 * Desktop (md and up): a sticky left column with the app name, the live badge and the nav.
 * Narrower: a top bar whose menu button expands the nav below it (Esc or navigating closes it).
 */
@Component({
  selector: 'app-fleet-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  providers: [FleetStore, AlertRulesStore],
  templateUrl: './fleet-shell.html',
  host: { '(document:keydown.escape)': 'closeMenu()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FleetShell implements OnInit {
  protected readonly store = inject(FleetStore);
  protected readonly liveLabel = computed(() => LIVE_LABELS[this.store.liveStatus()]);
  protected readonly navItems = NAV_ITEMS;
  /** Turbines needing attention (the Alerting page's rows), shown on the nav item. */
  protected readonly alertCount = computed(() => this.store.alerts().length);
  /** The narrow-screen menu (always shown from md up). */
  protected readonly menuOpen = signal(false);
  private readonly menuButton = viewChild.required<ElementRef<HTMLButtonElement>>('menuButton');

  constructor() {
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  ngOnInit(): void {
    this.store.init();
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  /** Esc: closes the menu and returns focus to its button. */
  protected closeMenu(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuButton().nativeElement.focus();
  }
}
