# SIU worked example — reproduction test data

**All figures illustrative, internally consistent.** This document exists so that
`packages/print`'s test suite has a checked-in source of truth to reproduce. It is not a
published print and none of these numbers describe real models or real prices.

Basket `SIU-2026a` weights: T1 0.50, T2 0.30, T3 0.20.

## Measured usage (input/output tokens per task)

| Model                  | T1       | T2         | T3        |
| ---------------------- | -------- | ---------- | --------- |
| A (frontier reasoning) | 1000/700 | 50000/1400 | 2000/6000 |
| B (frontier standard)  | 1000/320 | 50000/850  | 2000/2200 |
| C (mid-tier)           | 1050/380 | 52500/900  | 2100/2600 |
| D (open-weight hosted) | 1100/450 | 55000/1100 | 2200/3000 |

## Prices ($ per 1M tokens, input/output)

| Model | Input                                                                            | Output |
| ----- | -------------------------------------------------------------------------------- | ------ |
| A     | 3.00                                                                             | 15.00  |
| B     | 2.50                                                                             | 10.00  |
| C     | 0.60                                                                             | 2.40   |
| D     | across three hosts: 0.30/0.60, 0.20/0.45, 0.45/0.90 — **use host 2 = 0.20/0.45** |

## Quality gates

- A: pass / pass / pass
- B: pass / pass / pass
- C: pass / pass / pass-on-retry → T3 cost × 1.6 attempts
- D: pass / pass / **FAIL** → no T3 exchange rate, excluded from headline reference set

## Expected per-task costs

| Model | T1      | T2      | T3     | Basket    |
| ----- | ------- | ------- | ------ | --------- |
| A     | 0.0135  | 0.1710  | 0.0960 | 0.07725   |
| B     | 0.0057  | 0.1335  | 0.0270 | 0.04830   |
| C     | 0.00154 | 0.03366 | 0.0120 | 0.01327   |
| D     | 0.00042 | 0.01150 | n/a    | undefined |

C's T3 is `0.0075 × 1.6` (the 1.6 is the mean attempts-to-first-pass across its instances).

## Routed-market share weights (qualifying set only)

A 20%, B 35%, C 45%.

## Expected print

```
Dated SIU = 0.20×0.07725 + 0.35×0.04830 + 0.45×0.01327 = 0.0383
```

## Expected exchange-rate table

| Model | USD per SIU    | Spread to index | SIU per $1 |
| ----- | -------------- | --------------- | ---------- |
| A     | $0.0773        | +102%           | 12.9       |
| B     | $0.0483        | +26%            | 20.7       |
| C     | $0.0133        | −65%            | 75.3       |
| D     | n/a (fails T3) | —               | —          |

## Sensitivity — cache policy variant

Hypothetical only; T2 disables caching in the real basket.

If 40% of T2 input (20,000 tokens) is served from cache at 10% of input price, **applied to
B only**:

```
B T2 becomes 0.0885 → B basket 0.0348 → print 0.0336
Expected delta: −12.3%
```
