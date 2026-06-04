import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsBoolean,
  IsOptional,
} from 'class-validator';

export class GetBalanceQueryDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveTypeId: string;
}

export class ProcessDeductionDto {
  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveTypeId: string;

  @IsNumber()
  @IsPositive()
  days: number;
}

export class SetChaosDto {
  @IsBoolean()
  enabled: boolean;

  @IsNumber()
  @IsOptional()
  failureProbability?: number;
}

export class MutateBalanceDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveTypeId: string;

  @IsNumber()
  newAvailableDays: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
