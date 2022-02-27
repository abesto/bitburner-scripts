export enum Port {
  AutohackCommand = 1,
  AutohackResponse = 2,
}

export const Formats = {
  float: '0.000',
  money: '$0.000a',
};

export const epsilon = 0.00001;

// For our purposes, any chain of events with no more than this many milliseconds between the consecutive events are
// considered as happening in the same instant
export const timeEpsilon = 50;
