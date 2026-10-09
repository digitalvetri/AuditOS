-- Widen the client-books money columns from int4 to int8 (Prisma Int → BigInt).
--
-- A single amount above ₹2,14,74,836.47 (2^31-1 paise) did not fit in int4,
-- so a client's ₹30 crore capital, loan or plant, or a large invoice, could
-- not be saved. int4 → int8 is lossless.
--
-- safe-push.ts refuses every column type change on purpose, so this reviewed
-- file runs first in the migrate step (backend/Dockerfile, toolchain CMD).
-- Idempotent: each column is altered only when its table exists and the
-- column is still `integer` — a fresh database (tables not created yet) and
-- an already-widened one are both no-ops; safe-push then creates fresh
-- tables with bigint straight from the schema.
--
-- Locking: ALTER COLUMN ... TYPE rewrites each table under an ACCESS
-- EXCLUSIVE lock, so writes to these tables pause for the length of the
-- rewrite (seconds for typical sizes). Run it in the normal deploy window.
--
-- The firm's own money (Invoice, Quotation, Payment, payroll, expenses,
-- Zpay, LedgerTransaction) stays int4 and is NOT touched here.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('BookkeepingImportRun', 'totalPaise'),
      ('BookkeepingLedger', 'openingBalancePaise'),
      ('BookkeepingVoucher', 'totalDebitPaise'),
      ('BookkeepingVoucher', 'totalCreditPaise'),
      ('BookkeepingVoucher', 'taxableValuePaise'),
      ('BookkeepingVoucher', 'cgstPaise'),
      ('BookkeepingVoucher', 'sgstPaise'),
      ('BookkeepingVoucher', 'igstPaise'),
      ('BookkeepingVoucher', 'cessPaise'),
      ('BookkeepingVoucher', 'roundOffPaise'),
      ('BookkeepingVoucher', 'grandTotalPaise'),
      ('BookkeepingVoucherEntry', 'amountPaise'),
      ('BookkeepingVoucherEntry', 'foreignAmountMinor'),
      ('BookkeepingBillAllocation', 'amountPaise'),
      ('BookkeepingVoucherItem', 'ratePaise'),
      ('BookkeepingVoucherItem', 'discountPaise'),
      ('BookkeepingVoucherItem', 'amountPaise'),
      ('BookkeepingVoucherItem', 'cgstPaise'),
      ('BookkeepingVoucherItem', 'sgstPaise'),
      ('BookkeepingVoucherItem', 'igstPaise'),
      ('BookkeepingVoucherItem', 'cessPaise'),
      ('BookkeepingStockItem', 'standardCostPaise'),
      ('BookkeepingStockItem', 'standardPricePaise'),
      ('BookkeepingStockOpening', 'ratePaise'),
      ('BookkeepingStockOpening', 'valuePaise'),
      ('BookkeepingBankStatementLine', 'debitPaise'),
      ('BookkeepingBankStatementLine', 'creditPaise'),
      ('BookkeepingBankStatementLine', 'balancePaise'),
      ('BookkeepingBankReconciliation', 'bookBalancePaise'),
      ('BookkeepingBankReconciliation', 'statementBalancePaise'),
      ('BookkeepingBankReconciliation', 'differencePaise'),
      ('BookkeepingTaxRate', 'thresholdPaise'),
      ('BookkeepingPayHead', 'valuePaise'),
      ('BookkeepingSalaryStructureLine', 'valuePaise'),
      ('BookkeepingPayrollRun', 'grossPaise'),
      ('BookkeepingPayrollRun', 'deductionsPaise'),
      ('BookkeepingPayrollRun', 'netPaise'),
      ('BookkeepingPayrollLine', 'amountPaise'),
      ('EwayBill', 'valuePaise'),
      ('EInvoiceIrn', 'totalValuePaise'),
      ('AaTds26ASEntry', 'amountPaid'),
      ('AaTds26ASEntry', 'tdsAmount'),
      ('AaTds26ASEntry', 'tdsDeposited'),
      ('AaTdsBooksEntry', 'amountPaid'),
      ('AaTdsBooksEntry', 'tdsAmount'),
      ('AaGstFiling2BEntry', 'taxableValue'),
      ('AaGstFiling2BEntry', 'igst'),
      ('AaGstFiling2BEntry', 'cgst'),
      ('AaGstFiling2BEntry', 'sgst'),
      ('AaGstFiling2BEntry', 'cess'),
      ('AaGstFiling2BEntry', 'invoiceValue'),
      ('AaPurchaseRegisterEntry', 'taxableValue'),
      ('AaPurchaseRegisterEntry', 'igst'),
      ('AaPurchaseRegisterEntry', 'cgst'),
      ('AaPurchaseRegisterEntry', 'sgst'),
      ('AaPurchaseRegisterEntry', 'cess'),
      ('AaPurchaseRegisterEntry', 'invoiceValue')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = c.tbl AND column_name = c.col AND data_type = 'integer'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE bigint', c.tbl, c.col);
      RAISE NOTICE 'widened %.% to bigint', c.tbl, c.col;
    END IF;
  END LOOP;
END $$;
