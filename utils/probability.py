"""
Probability Utilities
=====================
Common probability functions used across quant research projects.
"""

import math
from itertools import combinations


def expected_value(outcomes):
    """
    Calculate expected value from a list of (probability, payoff) tuples.

    Args:
        outcomes: list of (probability, payoff) tuples

    Returns:
        float: expected value

    Example:
        >>> expected_value([(0.5, 10), (0.5, -5)])
        2.5
    """
    return sum(p * v for p, v in outcomes)


def combinations_count(n, k):
    """C(n, k) — number of ways to choose k items from n without replacement."""
    return math.comb(n, k)


def bayes(prior, likelihood, marginal):
    """
    Bayes' theorem: P(A|B) = P(B|A) * P(A) / P(B)

    Args:
        prior: P(A)
        likelihood: P(B|A)
        marginal: P(B)

    Returns:
        float: posterior P(A|B)
    """
    return (likelihood * prior) / marginal


def normal_pdf(x, mu=0, sigma=1):
    """Standard normal probability density function."""
    return (1 / (sigma * math.sqrt(2 * math.pi))) * math.exp(-0.5 * ((x - mu) / sigma) ** 2)
