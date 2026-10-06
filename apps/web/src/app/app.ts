import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<main class="mx-auto max-w-6xl px-4 py-8"><router-outlet /></main>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
