import { ChangeDetectionStrategy, Component } from '@angular/core';

/** /reporting: a placeholder until reports exist. */
@Component({
  selector: 'app-reporting-page',
  template: `
    <h1 class="text-3xl font-bold">Reporting</h1>
    <p
      class="mt-6 rounded-lg border border-line bg-surface px-4 py-6 text-muted"
      data-testid="reports-coming-soon"
    >
      Reports are coming soon.
    </p>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportingPage {}
