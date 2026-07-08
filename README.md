# Quant Research

Personal quant research repository covering probability modeling, prediction markets, credit risk, and algorithmic trading. Built to apply mathematical finance concepts to real market problems.

## Structure

| Folder | Description |
|---|---|
| `prediction_markets/` | EV framework, Bayesian updating, Kelly sizing for prediction market contracts |
| `credit_models/` | End-to-end ML pipeline for probability of default (PD) modeling |
| `utils/` | Shared probability and statistics utilities |
| `trading_bot/` | Frank369 NQ futures signal bot — ICT/SMT methodology, backtest engine, signal detection |

## Projects

### Prediction Market EV Model
Tools for evaluating prediction market contracts using Bayesian probability updating and Kelly criterion position sizing.

### Credit Default Model
ML pipeline achieving 95% ROC-AUC on structured financial data. Models include Logistic Regression, Random Forest, GAM, and KNN with GridSearchCV tuning.

### Frank369 Trading Bot
Algorithmic signal bot for NQ futures built on ICT/Frank-Zeussy methodology. Includes engines for FVG detection, SMT divergence, HTF bias, killzone timing, and session management. Backtest suite with 23+ runs and full trade logging.
