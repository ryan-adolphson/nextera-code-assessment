import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form, max, min, required, validate } from '@angular/forms/signals';
import { MatAutocomplete, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButton } from '@angular/material/button';
import { MatOption } from '@angular/material/core';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatError, MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { errorMessage, statusOf } from '../core/http-errors';
import { FleetStore } from '../fleet/fleet.store';
import { ScopeOption, filterOptions, scopeOptions } from '../reporting/report';
import { UnallocatedApi } from './unallocated-api.service';
import { UnallocatedStore } from './unallocated.store';
import {
  AssignRequest,
  UnallocatedOutcome,
  UnallocatedTurbine,
  isEntryGone,
} from './unallocated.model';

/** The farm field holds the chosen farm, or the text typed so far (not a choice yet). */
type FarmValue = ScopeOption | string | null;

/** The form's model: the farm and the optional coordinates (null while empty). */
interface AssignModel {
  farm: FarmValue;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Assigns an unknown turbine to a farm (opened by the Pending page with MatDialog): the farm from
 * a Material autocomplete of the fleet's farms (the Reporting page's Farms group), preselected
 * with the reported farm when it exists, and optional coordinates (both or neither; default the
 * farm's). A Signal Form submitted by `[formRoot]`: every field is marked touched and only a valid
 * form posts. Closes with the outcome on success, or `gone` when the entry was resolved elsewhere
 * (404); other failures (an unknown farm, a 409 because the turbine now exists, a 400, the network)
 * are shown here, and a 409 reloads the list behind the dialog.
 */
@Component({
  selector: 'app-assign-dialog',
  imports: [
    FormField,
    FormRoot,
    MatAutocomplete,
    MatAutocompleteTrigger,
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatDialogTitle,
    MatError,
    MatFormField,
    MatInput,
    MatLabel,
    MatOption,
    MatSuffix,
  ],
  templateUrl: './assign-dialog.html',
  host: { 'data-testid': 'assign-dialog' },
})
export class AssignDialog {
  private readonly api = inject(UnallocatedApi);
  private readonly dialog = inject<MatDialogRef<AssignDialog, UnallocatedOutcome>>(MatDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fleet = inject(FleetStore);
  /** The page's list (the page opens this dialog in its own injector). */
  private readonly store = inject(UnallocatedStore, { optional: true });
  protected readonly entry = inject<UnallocatedTurbine>(MAT_DIALOG_DATA);

  /** The fleet's farms, as the Reporting page's Farms group ("Prairie Ridge (FARM01)"). */
  private readonly farms = computed(() => scopeOptions(this.fleet.farms(), []).farms);

  private readonly model = signal<AssignModel>({
    farm: this.farms().find((f) => f.id === this.entry.reportedFarm?.id) ?? null,
    latitude: null,
    longitude: null,
  });
  protected readonly assignForm = form(
    this.model,
    (assign) => {
      required(assign.farm);
      // A farm picked from the list (typed text alone doesn't count).
      validate(assign.farm, ({ value }) => {
        const farm = value();
        return typeof farm === 'string' && farm ? { kind: 'chooseOption' } : undefined;
      });
      // Coordinates: both or neither (each is required once the other is filled in).
      required(assign.latitude, { when: ({ valueOf }) => valueOf(assign.longitude) !== null });
      required(assign.longitude, { when: ({ valueOf }) => valueOf(assign.latitude) !== null });
      min(assign.latitude, -90);
      max(assign.latitude, 90);
      min(assign.longitude, -180);
      max(assign.longitude, 180);
    },
    { submission: { action: () => this.save(), onInvalid: () => this.error.set(null) } },
  );

  /** The autocomplete's `displayWith`: a chosen farm's label, or the typed text. */
  protected readonly displayFarm = (value: FarmValue): string =>
    typeof value === 'string' ? value : (value?.label ?? '');
  /** The farms matching what was typed (all of them for a chosen farm's full label). */
  protected readonly filtered = computed(() =>
    filterOptions(this.farms(), this.displayFarm(this.model().farm)),
  );

  /** An assign is in flight (`submit()` also ignores a second submit meanwhile). */
  protected readonly saving = computed(() => this.assignForm().submitting());
  protected readonly error = signal<string | null>(null);

  protected farmError(): string {
    return this.assignForm.farm().getError('chooseOption')
      ? 'Choose a farm from the list.'
      : 'Choose a farm.';
  }

  protected coordinateError(field: 'latitude' | 'longitude'): string {
    const state = this.assignForm[field]();
    const [low, high] = field === 'latitude' ? [-90, 90] : [-180, 180];
    if (state.getError('required')) return 'Enter both coordinates, or neither.';
    return `Enter a number from ${low} to ${high}.`;
  }

  /** The submit action (valid form only): resolves when the request ends. */
  private save(): Promise<undefined> {
    this.error.set(null);
    const { farm, latitude, longitude } = this.model();
    const body: AssignRequest = { farmId: (farm as ScopeOption).id };
    if (latitude !== null && longitude !== null) {
      body.latitude = latitude;
      body.longitude = longitude;
    }
    return new Promise((resolve) =>
      this.api
        .assign(this.entry.id, body)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (resolution) => {
            this.dialog.close({ kind: 'resolved', resolution });
            resolve(undefined);
          },
          error: (e: unknown) => {
            if (isEntryGone(e)) {
              this.dialog.close({ kind: 'gone' });
            } else {
              this.error.set(errorMessage(e));
              // E.g. the turbine was created meanwhile: the list behind may be stale.
              if (statusOf(e) === 409) this.store?.reload();
            }
            resolve(undefined);
          },
        }),
    );
  }
}
