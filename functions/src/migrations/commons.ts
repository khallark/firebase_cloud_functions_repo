export interface MigrationStats {
  accountsProcessed: number;
  ordersScanned: number;
  ordersUpdated: number;
  ordersSkipped: number;
  errors: number;
}
