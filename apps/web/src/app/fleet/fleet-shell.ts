import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthStore } from '../core/auth/auth.store';
import { ROLE_LABELS, Role } from '../core/auth/roles';
import { IconName } from '../ui/icons';
import { FleetStore, LiveStatus } from './fleet.store';

const LIVE_LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

/**
 * The main navigation, in order. `id` is the `nav-<id>` test hook; `icon` a Material Symbol;
 * `minRole` the role that sees it (the route has the same guard, and the API enforces it).
 */
export const NAV_ITEMS = [
  { id: 'farms', path: '/farms', label: 'Farms', icon: 'map', minRole: 'viewer' },
  { id: 'turbines', path: '/turbines', label: 'Turbines', icon: 'wind-power', minRole: 'viewer' },
  {
    id: 'alerting',
    path: '/alerting',
    label: 'Alerting',
    icon: 'notifications',
    minRole: 'viewer',
  },
  { id: 'reporting', path: '/reporting', label: 'Reporting', icon: 'bar-chart', minRole: 'owner' },
] as const satisfies readonly {
  id: string;
  path: string;
  label: string;
  icon: IconName;
  minRole: Role;
}[];

/**
 * Parent of every page: the side navigation and the page region. Owns the FleetStore (provided
 * here, so all pages share it): the fleet is loaded and the SSE connection opened once, and
 * navigating between pages neither reloads nor reconnects.
 *
 * Desktop (md and up): a sticky left column with the app name, the live badge and the nav.
 * Narrower: a top bar whose menu button expands the nav below it (Esc or navigating closes it).
 * A route with `data: { fillViewport: true }` gets a window-high layout: the page is a flex column
 * exactly as tall as the space left, so it can scroll a part of itself (e.g. a table) instead of
 * the window. On screens too short for its minimum, the main area scrolls.
 */
@Component({
  selector: 'app-fleet-shell',
  imports: [MatButton, MatIcon, MatIconButton, RouterLink, RouterLinkActive, RouterOutlet],
  providers: [FleetStore],
  templateUrl: './fleet-shell.html',
  host: { '(document:keydown.escape)': 'closeMenu()' },
})
export class FleetShell implements OnInit {
  protected readonly store = inject(FleetStore);
  protected readonly liveLabel = computed(() => LIVE_LABELS[this.store.liveStatus()]);
  protected readonly auth = inject(AuthStore);
  /** The sections the user's role may open (Reporting: owner and up). */
  protected readonly navItems = computed(() =>
    NAV_ITEMS.filter((item) => this.auth.can(item.minRole)),
  );
  protected readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? ROLE_LABELS[role] : '';
  });
  /** The narrow-screen menu (always shown from md up). */
  protected readonly menuOpen = signal(false);
  /** The current route asks for a window-high page (route data `fillViewport`). */
  protected readonly fillViewport = signal(false);
  private readonly router = inject(Router);
  // read: ElementRef: the ref is on a MatIconButton, which would otherwise be the component.
  private readonly menuButton = viewChild.required('menuButton', {
    read: ElementRef<HTMLButtonElement>,
  });

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.menuOpen.set(false);
        this.fillViewport.set(this.deepestRouteData()['fillViewport'] === true);
      });
  }

  ngOnInit(): void {
    this.store.init();
  }

  private deepestRouteData(): Record<string, unknown> {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.data;
  }

  /** Sign out: forgets the session and goes to /login (which closes the live connection). */
  protected signOut(): void {
    this.auth.logout();
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
