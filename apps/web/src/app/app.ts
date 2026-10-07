import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** The page layout (side navigation, main region) is the FleetShell's. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {}
