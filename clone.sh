#!/bin/sh

echo "Cloning repositories..."

SITES=$HOME/_src
PERSONAL=$SITES/personal
WORK=$SITES/work

# Personal
git clone git@github.com:tommybarvaag/tommylb.git $PERSONAL
git clone git@github.com:tommybarvaag/show-me-the-money.git $PERSONAL
git clone git@github.com:tommybarvaag/norwegian-calendar.git $PERSONAL

# Work