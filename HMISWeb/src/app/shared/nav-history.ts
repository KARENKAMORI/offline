import { Injectable, inject } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Back goes to the previous screen in this app, or to a fallback when the page was opened directly. */
@Injectable({ providedIn: 'root' })
export class NavHistory {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private depth = 0;

  constructor() {
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.depth++);
  }

  back(fallback: string): void {
    if (this.depth > 1) {
      this.depth -= 2;
      this.location.back();
    } else {
      void this.router.navigateByUrl(fallback, { replaceUrl: true });
    }
  }
}
