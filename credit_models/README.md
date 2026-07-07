# Credit Default Prediction Model

End-to-end ML pipeline for probability of default (PD) modeling on structured financial data.

## Model Performance
- ROC-AUC: 95% on holdout set
- Models trained: Logistic Regression, Random Forest, GAM, KNN
- Hyperparameter tuning via GridSearchCV

## Approach
Framed evaluation metrics around credit risk decision-making — connecting model output to real lending trade-offs and expected loss estimation. Threshold selection optimized for F1 vs precision-recall tradeoff depending on cost of false negatives.

## Files
- `pd_model.py` — full training pipeline
- `evaluation.py` — ROC-AUC, KS statistic, Gini coefficient
- `features.py` — feature engineering and selection
